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
  screen: process.env.LLM_TIER_SCREEN || process.env.LLM_MODEL || 'MiMO-V2.5',
  analyze: process.env.LLM_TIER_ANALYZE || process.env.LLM_MODEL || 'MiMO-V2.5-Pro',
  final: process.env.LLM_TIER_FINAL || process.env.LLM_MODEL || 'MiMO-V2-Omni',
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

/** Rough per-call cost heuristic based on token count. */
function estimateCost(model, totalTokens) {
  const rates = {
    'MiMO-V2.5': 0.000001,
    'MiMO-V2.5-Pro': 0.000005,
    'MiMO-V2-Omni': 0.000008,
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
async function callTier(messages, tier) {
  const model = MODELS[tier];
  if (!model) throw new Error(`[llmRouter] Unknown tier: ${tier}`);

  let res;
  try {
    res = await axios.post(
      `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      {
        model,
        messages,
        temperature: 0.2,
        max_tokens: Number(process.env.LLM_MAX_TOKENS || 1500),
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
// Build the shared system + user messages (mirrors llm.js prompt logic)
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
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
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
  const content = rawResponse?.choices?.[0]?.message?.content || '';
  if (!content.trim()) {
    throw new Error('LLM returned an empty response content');
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
    // ── Tier 1: screen ───────────────────────────────────────────────────
    const t1Raw = await callTier(messages, 'screen');
    const t1Confidence = extractConfidence(t1Raw);
    console.log(`[llmRouter] tier=screen model=${t1Raw._model} confidence=${t1Confidence} budget=$${BUDGET.windowCost.toFixed(4)}`);

    if (t1Confidence >= screenThreshold) {
      return parseBatchResponse(t1Raw, rows);
    }

    // ── Tier 2: analyze ─────────────────────────────────────────────────
    if (!checkBudget()) {
      console.log('[llmRouter] budget exhausted before tier 2 escalation, using tier 1 result.');
      return parseBatchResponse(t1Raw, rows);
    }

    console.log(`[llmRouter] escalating to tier=analyze (screen confidence ${t1Confidence} < ${screenThreshold})`);
    const t2Raw = await callTier(messages, 'analyze');
    const t2Confidence = extractConfidence(t2Raw);
    console.log(`[llmRouter] tier=analyze model=${t2Raw._model} confidence=${t2Confidence} budget=$${BUDGET.windowCost.toFixed(4)}`);

    // Optional Tier 3 escalation — only if env var LLM_TIER_FINAL is explicitly set
    if (t2Confidence < analyzeThreshold && process.env.LLM_TIER_FINAL && checkBudget()) {
      console.log(`[llmRouter] escalating to tier=final (analyze confidence ${t2Confidence} < ${analyzeThreshold})`);
      const t3Raw = await callTier(messages, 'final');
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
