import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

/**
 * Compute the 4 Sniper Lock confidence signals from raw candidate data.
 * All signals are informational only — the LLM decides how to weight them.
 */
export function computeSniperLockMetrics(c) {
  // --- 1. Volume Spike (last candle vs average of earlier candles in 5m window) ---
  let volumeSpike = null;
  try {
    const candles = c.chart?.windows?.find(w => w.label === 'ath_context_24h_5m')?.candles ?? [];
    // We don't have individual candle data in the summarized window, so use the trending stats
    // instead: compare 5m volume to 1h volume as a spike signal
    const vol5m = Number(c.trending?.stats5m?.buyVolume ?? 0) + Number(c.trending?.stats5m?.sellVolume ?? 0);
    const vol1h = Number(c.trending?.stats1h?.buyVolume ?? 0) + Number(c.trending?.stats1h?.sellVolume ?? 0);
    const avgPer5m = vol1h > 0 ? vol1h / 12 : null;  // 12 x 5min = 1h
    if (vol5m > 0 && avgPer5m !== null && avgPer5m > 0) {
      const ratio = vol5m / avgPer5m;
      volumeSpike = {
        vol5m_usd: Math.round(vol5m),
        avg_per_5m_usd: Math.round(avgPer5m),
        spike_ratio: Math.round(ratio * 100) / 100,
        is_spike: ratio >= 2.0,  // 2x average = meaningful spike
      };
    }
  } catch { /* non-blocking */ }

  // --- 2. Top 10 Buyer Average (holders sorted by amount, average of top 10) ---
  let top10BuyerAvg = null;
  try {
    const top10 = (c.holders?.top20 ?? []).slice(0, 10);
    if (top10.length > 0) {
      const avgPct = top10.reduce((sum, h) => sum + Number(h.percent || 0), 0) / top10.length;
      const top10TotalPct = top10.reduce((sum, h) => sum + Number(h.percent || 0), 0);
      // We don't have individual avg buy prices from Jupiter holders API (it only gives balances).
      // Report concentration instead, which the LLM can use as a proxy for risk.
      top10BuyerAvg = {
        holder_count: top10.length,
        avg_holding_pct: Math.round(avgPct * 100) / 100,
        top10_total_pct: Math.round(top10TotalPct * 100) / 100,
        // If top 10 hold > 60%, entry is risky (high distribution risk)
        concentration_risk: top10TotalPct > 60 ? 'HIGH' : top10TotalPct > 35 ? 'MEDIUM' : 'LOW',
      };
    }
  } catch { /* non-blocking */ }

  // --- 3. Stochastic RSI approximation (1m TF data not fetched; use 5m candle window summary) ---
  // Note: True Stoch RSI requires individual candle closes. The summarized windows don't carry
  // raw candles. We report the available ATH distance as a proxy for overbought/oversold signal.
  let stochRsiProxy = null;
  try {
    const athWindow = c.chart?.windows?.find(w => w.label === 'ath_context_24h_5m' && w.available);
    if (athWindow) {
      const distFromHigh = Number(athWindow.belowHighPercent ?? athWindow.distanceFromHighPercent ?? 0);
      const aboveLow = Number(athWindow.aboveLowPercent ?? 0);
      // Rough oversold heuristic: price is far below 24h high AND close to 24h low
      const isOversoldProxy = distFromHigh < -40 && aboveLow < 20;
      stochRsiProxy = {
        source: '5m_ath_window_proxy',
        dist_from_24h_high_pct: Math.round(distFromHigh * 100) / 100,
        above_24h_low_pct: Math.round(aboveLow * 100) / 100,
        oversold_proxy: isOversoldProxy,
        note: 'True Stoch RSI 1m requires raw candle data; this is a structural proxy.',
      };
    }
  } catch { /* non-blocking */ }

  // --- 4. Smart Wallet / KOL exposure (already available) ---
  const smartWallet = {
    holder_count: Number(c.savedWalletExposure?.holderCount ?? 0),
    wallets: c.savedWalletExposure?.wallets ?? [],
    has_smart_money: Number(c.savedWalletExposure?.holderCount ?? 0) > 0,
  };

  // --- Token age (key for mode switching) ---
  const ageMs = c.createdAtMs ? Date.now() - Number(c.createdAtMs) : null;
  const ageMins = ageMs !== null ? Math.round(ageMs / 60000) : null;

  return {
    token_age_mins: ageMins,
    entry_mode: ageMins !== null ? (ageMins < 60 ? 'FRESH' : 'CONSOLIDATION') : 'UNKNOWN',
    volume_spike: volumeSpike,
    top10_concentration: top10BuyerAvg,
    stoch_rsi_proxy: stochRsiProxy,
    smart_wallet: smartWallet,
  };
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    // Sniper Lock confidence signals — always computed, LLM ignores if strategy doesn't use them
    sniper_lock_signals: computeSniperLockMetrics(c),
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
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

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
