import axios from 'axios';
import { LLM_BASE_URL, LLM_API_KEY, LLM_TIMEOUT_MS, ENABLE_LLM } from '../config.js';
import {
  normalizeDecision,
  activeLessonsForPrompt,
  compactCandidateForLlm,
} from './llm.js';
import { numSetting } from '../db/settings.js';
import { stripThinking, strictJsonFromText, safeJson } from '../utils.js';

// ---------------------------------------------------------------------------
// Tier model names — read from env, fall back to safe defaults
// ---------------------------------------------------------------------------
const MODELS = {
  screen: process.env.LLM_TIER_SCREEN || process.env.LLM_MODEL || 'mimo-v2.5',
  analyze: process.env.LLM_TIER_ANALYZE || process.env.LLM_MODEL || 'mimo-v2.5-pro',
  final: process.env.LLM_TIER_FINAL || process.env.LLM_MODEL || 'mimo-v2-omni',
};

// ---------------------------------------------------------------------------
// Budget tracker — resets every 5-hour window
// ---------------------------------------------------------------------------
const BUDGET = {
  windowStart: Date.now(),
  windowCost: 0,
  WINDOW_MS: 5 * 60 * 60 * 1_000, // 5 hours
  get LIMIT_USD() {
    return Number(process.env.LLM_BUDGET_LIMIT_USD || 10);
  },
};

/** Resets window if expired, then returns true if still under budget. */
function checkBudget() {
  const now = Date.now();
  if (now - BUDGET.windowStart > BUDGET.WINDOW_MS) {
    BUDGET.windowStart = now;
    BUDGET.windowCost = 0;
  }
  return BUDGET.windowCost < BUDGET.LIMIT_USD;
}

/** Rough per-call cost heuristic based on token count.
 *  MiMO Standard plan: 200M credits/month. Assuming $30/month → $0.00000015/token.
 *  We use a 5x safety buffer over the estimate so the budget guard trips earlier than billing. */
function estimateCost(model, totalTokens) {
  const rates = {
    'mimo-v2.5':     0.0000003,
    'mimo-v2.5-pro': 0.0000008,
    'mimo-v2-omni':  0.0000015,
  };
  return totalTokens * (rates[model] ?? 0.000001);
}

/** Returns current 5-hour window spend (USD). */
export function currentWindowCost() {
  return BUDGET.windowCost;
}

// ---------------------------------------------------------------------------
// Core HTTP call for a single tier
// ---------------------------------------------------------------------------
async function callTier(messages, tier, maxTokensOverride) {
  const model = MODELS[tier];
  if (!model) throw new Error(`[llmRouter] Unknown tier: ${tier}`);

  const maxTokens = maxTokensOverride ?? Number(process.env.LLM_MAX_TOKENS || 2500);

  let res;
  try {
    res = await axios.post(
      `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        model,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
      },
      {
        timeout: LLM_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${LLM_API_KEY}`,
          'content-type': 'application/json',
        },
      },
    );
  } catch (axiosErr) {
    // Log full error details so we can see the actual API error body
    const status = axiosErr.response?.status;
    const body = JSON.stringify(axiosErr.response?.data)?.slice(0, 300) || axiosErr.message;
    throw new Error(`HTTP ${status ?? 'ERR'} from ${tier}: ${body}`);
  }

  // Validate response shape — opencode.ai may return {error:...} with status 200
  const data = res.data;
  if (data?.error) {
    const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw new Error(`API error (${tier}): ${errMsg}`);
  }
  if (!Array.isArray(data?.choices) || data.choices.length === 0) {
    const snippet = JSON.stringify(data)?.slice(0, 200) || '(empty body)';
    throw new Error(`No choices in response (${tier}): ${snippet}`);
  }

  // Warn if truncated
  const finishReason = data.choices[0]?.finish_reason;
  if (finishReason === 'length') {
    console.log(`[llmRouter] warning: ${tier} response truncated (finish_reason=length, max_tokens=${maxTokens}). Consider raising LLM_MAX_TOKENS.`);
  }

  // Track estimated cost
  const usage = data?.usage;
  if (usage?.total_tokens) {
    BUDGET.windowCost += estimateCost(model, usage.total_tokens);
  }

  return { ...data, _tier: tier, _model: model };
}

// ---------------------------------------------------------------------------
// Extract confidence from a raw LLM response (never throws)
// ---------------------------------------------------------------------------
function extractConfidence(rawResponse) {
  const content = rawResponse?.choices?.[0]?.message?.content || '';
  if (!content) return 0;
  const stripped = stripThinking(content);
  // Try strict JSON first, then regex fallback
  const parsed = safeJson(stripped.match(/\{[\s\S]*\}/)?.[0] || '', null);
  if (parsed?.confidence != null) return Number(parsed.confidence) || 0;
  const match = stripped.match(/"?confidence"?\s*[:\s]+([0-9]+)/);
  return match ? Number(match[1]) : 0;
}

// ---------------------------------------------------------------------------
// Build a LIGHTWEIGHT screen-only prompt — asks only for verdict + confidence
// This keeps the output small enough to fit in LLM_SCREEN_MAX_TOKENS.
// ---------------------------------------------------------------------------
function buildScreenMessages(rows) {
  const system = [
    'You are a Solana token screener.',
    'Return ONLY a single-line JSON object with three fields: verdict (BUY|WATCH|PASS), confidence (0-100), and reason (short string).',
    'Do NOT include any other fields.',
    'Be concise.',
  ].join(' ');

  const user = {
    task: 'Quickly screen these Solana meme coin candidates. Pick the single most promising one or return PASS.',
    candidates: rows.map(r => ({
      id: r.id,
      mint: r.candidate?.token?.mint,
      mcap: r.candidate?.token?.market_cap,
      volume_24h: r.candidate?.token?.volume_24h,
      price_change_24h: r.candidate?.token?.price_change_24h,
      strategy: r.candidate?.strategy,
    })),
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(user) },
  ];
}

// ---------------------------------------------------------------------------
// Build the full system + user messages for tier-2/3 analysis
// ---------------------------------------------------------------------------
function buildBatchMessages(rows, triggerCandidateId) {
  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');

  const user = {
    task: 'Pick the best buy candidate, or PASS. Keep reason under 15 words.',
    recent_lessons: activeLessonsForPrompt(),
    output_example: '{"verdict":"BUY","selected_candidate_id":12,"selected_mint":"mint...","confidence":72,"reason":"strong vol surge, early entry","risks":"rug risk","suggested_tp_percent":60,"suggested_sl_percent":-25}',
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(user) },
  ];
}

// ---------------------------------------------------------------------------
// Parse a raw API response into a normalised batch decision
// ---------------------------------------------------------------------------
function parseBatchResponse(rawResponse, rows) {
  const choice = rawResponse?.choices?.[0];
  const content = choice?.message?.content || '';
  if (!content.trim()) {
    const reason = choice?.finish_reason || 'unknown';
    throw new Error(`LLM returned an empty response content (finish_reason: ${reason})`);
  }
  const stripped = stripThinking(content);
  const parsed = strictJsonFromText(stripped);
  const decision = normalizeDecision(parsed);
  const selectedId = Number(parsed?.selected_candidate_id);
  const selectedMint = String(parsed?.selected_mint || '');
  const row = rows.find(r => r.id === selectedId || r.candidate?.token?.mint === selectedMint);
  return {
    ...decision,
    selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
    selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
    selected_row: decision.verdict === 'BUY' && row ? row : null,
    _tier: rawResponse._tier,
    _model: rawResponse._model,
  };
}

// ---------------------------------------------------------------------------
// Public API — drop-in replacement for decideCandidateBatch
// ---------------------------------------------------------------------------

/**
 * Tiered batch screening with automatic escalation.
 *
 * Tier 1  (screen)  — cheap/fast model, e.g. deepseek-v4-flash
 * Tier 2  (analyze) — mid-tier model,   e.g. deepseek-v4-pro
 *
 * If Tier 1 confidence < LLM_SCREEN_CONFIDENCE_THRESHOLD, escalates to Tier 2.
 *
 * Returns the same shape as the original decideCandidateBatch.
 */
export async function decideCandidateBatchRouted(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  // Budget guard
  if (!checkBudget()) {
    console.log(`[llmRouter] 5-hour budget exhausted ($${BUDGET.windowCost.toFixed(4)} / $${BUDGET.LIMIT_USD}). Returning WATCH.`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM 5-hour budget window exhausted.',
      risks: ['budget_exceeded'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
      _budget_exceeded: true,
    };
  }

  const messages = buildBatchMessages(rows, triggerCandidateId);
  const screenThreshold = Number(process.env.LLM_SCREEN_CONFIDENCE_THRESHOLD || 40);
  const analyzeThreshold = Number(process.env.LLM_ANALYZE_CONFIDENCE_THRESHOLD || 60);

  try {
    // ── Tier 1: screen — lightweight prompt, small token budget
    const screenMaxTokens = Number(process.env.LLM_SCREEN_MAX_TOKENS || 300);
    const screenMessages = buildScreenMessages(rows);
    const t1Raw = await callTier(screenMessages, 'screen', screenMaxTokens);
    const t1Confidence = extractConfidence(t1Raw);
    console.log(`[llmRouter] tier=screen model=${t1Raw._model} confidence=${t1Confidence} budget=$${BUDGET.windowCost.toFixed(4)}`);

    if (t1Confidence >= screenThreshold) {
      // Tier 1 was confident enough — now fetch the full analysis from tier 1
      // before returning, so we have reason/risks/tp/sl fields.
      const fullMessages = buildBatchMessages(rows, triggerCandidateId);
      const t1FullRaw = await callTier(fullMessages, 'screen');
      return parseBatchResponse(t1FullRaw, rows);
    }

    // ── Tier 2: analyze — full prompt, full token budget
    if (!checkBudget()) {
      console.log('[llmRouter] budget exhausted before tier 2 escalation, using tier 1 result.');
      return parseBatchResponse(t1Raw, rows);
    }

    console.log(`[llmRouter] escalating to tier=analyze (screen confidence ${t1Confidence} < ${screenThreshold})`);
    const fullMessages = buildBatchMessages(rows, triggerCandidateId);
    const t2Raw = await callTier(fullMessages, 'analyze');
    const t2Confidence = extractConfidence(t2Raw);
    console.log(`[llmRouter] tier=analyze model=${t2Raw._model} confidence=${t2Confidence} budget=$${BUDGET.windowCost.toFixed(4)}`);

    // Optional Tier 3 escalation — only if env var LLM_TIER_FINAL is explicitly set
    if (t2Confidence < analyzeThreshold && process.env.LLM_TIER_FINAL && checkBudget()) {
      console.log(`[llmRouter] escalating to tier=final (analyze confidence ${t2Confidence} < ${analyzeThreshold})`);
      const t3Raw = await callTier(fullMessages, 'final');
      console.log(`[llmRouter] tier=final model=${t3Raw._model} budget=$${BUDGET.windowCost.toFixed(4)}`);
      return parseBatchResponse(t3Raw, rows);
    }

    return parseBatchResponse(t2Raw, rows);

  } catch (err) {
    console.log(`[llmRouter] error: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM router failed: ${err.message}`,
      risks: ['llm_router_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}
