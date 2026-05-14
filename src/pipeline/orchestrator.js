import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { decideCandidateBatchRouted, currentWindowCost } from './llmRouter.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';
import { canEnterNewPositions } from '../agentState.js';

export const seenSignalCandidates = new Map();

const USE_LLM_ROUTER = Boolean(process.env.LLM_TIER_SCREEN);
let _budgetAlertSent = false;

// ── Batch accumulator ─────────────────────────────────────────────────────────
// Collect filtered candidates, fire LLM when batch full or timeout
const BATCH_FLUSH_MIN = 3;   // flush when this many pending
const BATCH_FLUSH_MAX = 5;   // cap rows sent to LLM
const BATCH_TIMEOUT_MS = 10_000;
const URGENT_MIN_SIGNALS = 3; // bypass batch: fire solo immediately

const _batchPending = new Map(); // candidateId → triggeredAt
let _batchTimer = null;
let _batchRunning = false;

function signalOverlapCount(signals = {}) {
  return [signals.hasFeeClaim, signals.hasGraduated, signals.hasTrending].filter(Boolean).length;
}

function scheduleBatchFlush() {
  if (_batchTimer) return;
  _batchTimer = setTimeout(() => {
    runBatchFlush('timeout').catch(err => console.log(`[batch] timeout flush error: ${err.message}`));
  }, BATCH_TIMEOUT_MS);
}

async function runBatchFlush(reason = 'batch_full') {
  if (_batchTimer) { clearTimeout(_batchTimer); _batchTimer = null; }
  if (_batchPending.size === 0) return;
  if (_batchRunning) {
    // LLM in progress — reschedule
    scheduleBatchFlush();
    return;
  }

  const pendingIds = [..._batchPending.keys()];
  _batchPending.clear();
  const triggerCandidateId = pendingIds[pendingIds.length - 1];

  const batchSize = Math.min(BATCH_FLUSH_MAX, Math.max(BATCH_FLUSH_MIN, numSetting('llm_candidate_pick_count', 5)));
  const rows = recentEligibleCandidates(batchSize);
  if (!rows.length) return;

  console.log(`[batch] flush (${reason}) ${rows.length}/${pendingIds.length} candidates, trigger #${triggerCandidateId}`);
  _batchRunning = true;
  try {
    await runLlmDecision(rows, triggerCandidateId, 'batch');
  } finally {
    _batchRunning = false;
  }
}

// ── Core LLM decision + downstream ───────────────────────────────────────────
async function runLlmDecision(rows, triggerCandidateId, mode = 'batch') {
  const strat = activeStrategy();
  let batchDecision, batchId;

  if (USE_LLM_ROUTER) {
    batchDecision = await decideCandidateBatchRouted(rows, triggerCandidateId);
    if (batchDecision._budget_exceeded && !_budgetAlertSent) {
      _budgetAlertSent = true;
      await sendTelegram(`⚠️ <b>LLM Budget Window Exhausted</b>\n\nSpend this 5-hour window: <code>$${currentWindowCost().toFixed(4)}</code>\nBot will return WATCH for all LLM calls until the window resets.`);
    }
  } else {
    batchDecision = await decideCandidateBatch(rows, triggerCandidateId);
  }
  batchId = storeBatchDecision(triggerCandidateId, rows, batchDecision);

  const selectedRow = batchDecision.selected_row;

  // Store decisions for every candidate in the batch
  for (const row of rows) {
    const isSelected = selectedRow?.id === row.id;
    const decision = isSelected
      ? batchDecision
      : {
          ...batchDecision,
          verdict: 'WATCH',
          reason: selectedRow
            ? `Batch #${batchId} (${mode}) screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
            : `Batch #${batchId} (${mode}) screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
        };
    const decisionId = storeDecision(row.id, row.candidate, decision);
    if (isSelected) batchDecision.id = decisionId;
    updateCandidateStatus(row.id, decision.verdict.toLowerCase());
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, triggerCandidateId);

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence', 75)) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, triggerCandidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 75),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

// ── Main signal handler ───────────────────────────────────────────────────────
setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  if (!canEnterNewPositions()) {
    console.log(`[agent] paused/stopped, skipping signal ${signals.mint?.slice(0, 8)}...`);
    return;
  }
  if (!canOpenMorePositions()) {
    const strat = activeStrategy();
    const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const strat = activeStrategy();

  // Rule-based: no LLM, immediate buy
  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    const batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
    const decisionId = storeDecision(candidateId, candidate, batchDecision);
    batchDecision.id = decisionId;
    updateCandidateStatus(candidateId, 'buy');
    if (selfRow && boolSetting('agent_enabled', true)) {
      await handleApprovedBuy(selfRow, batchDecision, null, selfRow ? [selfRow] : [], candidateId);
    }
    return;
  }

  // Urgent bypass: ≥3 signal overlap → solo LLM immediately, skip accumulator
  const overlap = signalOverlapCount(signals);
  if (overlap >= URGENT_MIN_SIGNALS) {
    const selfRow = candidateById(candidateId);
    if (selfRow) {
      console.log(`[batch] urgent bypass: ${signals.mint?.slice(0, 8)} overlap=${overlap}, solo LLM`);
      await runLlmDecision([selfRow], candidateId, 'urgent');
    }
    return;
  }

  // Normal: add to batch accumulator
  _batchPending.set(candidateId, now());
  console.log(`[batch] queued #${candidateId} (${signals.mint?.slice(0, 8)}) overlap=${overlap}, pending=${_batchPending.size}`);

  if (_batchPending.size >= BATCH_FLUSH_MIN) {
    await runBatchFlush('batch_full');
  } else {
    scheduleBatchFlush();
  }
}

// ── Buy execution ─────────────────────────────────────────────────────────────
export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
