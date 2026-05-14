import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';
import { numSetting } from './settings.js';
import { queueWrite } from './batchWriter.js';

export function storeDecision(candidateId, candidate, decision) {
  const result = db.prepare(`
    INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    now(),
    decision.verdict,
    decision.confidence,
    decision.reason || null,
    json(decision.risks || []),
    json(decision),
  );
  return Number(result.lastInsertRowid);
}

export function storeBatchDecision(triggerCandidateId, rows, batchDecision) {
  const selectedRow = batchDecision.selected_row;
  const result = db.prepare(`
    INSERT INTO llm_batches (created_at_ms, trigger_candidate_id, selected_candidate_id, selected_mint, verdict, confidence, reason, risks_json, raw_json, candidate_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    triggerCandidateId,
    selectedRow?.id || null,
    selectedRow?.candidate?.token?.mint || null,
    batchDecision.verdict,
    batchDecision.confidence,
    batchDecision.reason || null,
    json(batchDecision.risks || []),
    json(batchDecision),
    json(rows.map(row => row.id)),
  );
  return Number(result.lastInsertRowid);
}

export function batchById(batchId) {
  const batch = db.prepare('SELECT * FROM llm_batches WHERE id = ?').get(batchId);
  if (!batch) return null;
  const candidateIds = safeJson(batch.candidate_ids_json, []);
  const rows = candidateIds.map(id => {
    const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
    return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
  }).filter(Boolean);
  return { ...batch, rows };
}

const _insertDecisionLog = db.prepare(`
  INSERT INTO decision_logs (
    at_ms, batch_id, trigger_candidate_id, selected_candidate_id, selected_mint,
    mode, action, verdict, confidence, reason, guardrails_json, token_json,
    candidate_json, batch_json, execution_json, strategy_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function logDecisionEvent({
  batchId = null,
  triggerCandidateId = null,
  selectedRow = null,
  rows = [],
  decision = {},
  mode = 'dry_run',
  action,
  guardrails = {},
  execution = {},
}) {
  const selectedCandidate = selectedRow?.candidate || null;
  const strategyId = selectedCandidate?.filters?.strategy
    || rows.find(row => row?.candidate?.filters?.strategy)?.candidate?.filters?.strategy
    || null;
  const params = [
    now(),
    batchId,
    triggerCandidateId,
    selectedRow?.id || null,
    selectedCandidate?.token?.mint || decision.selected_mint || null,
    mode,
    action,
    decision.verdict || null,
    decision.confidence ?? null,
    decision.reason || null,
    json(guardrails),
    json(selectedCandidate?.token || null),
    json(selectedCandidate || null),
    json(rows.map(row => {
      if (!row) return null;
      const c = row.candidate;
      return {
        candidateId: row.id,
        mint: c.token?.mint,
        route: c.signals?.route,
        signals: c.signals,
        token: c.token,
        metrics: c.metrics,
        feeClaim: c.feeClaim,
        trending: c.trending,
        holders: {
          count: c.holders?.count,
          top20Percent: c.holders?.top20Percent,
          maxHolderPercent: c.holders?.maxHolderPercent,
          top20: c.holders?.top20,
        },
        chart: c.chart,
        savedWalletExposure: c.savedWalletExposure,
        twitterNarrative: c.twitterNarrative,
        filters: c.filters,
        createdAtMs: c.createdAtMs,
      };
    })),
    json(execution),
    strategyId,
  ];
  queueWrite(() => _insertDecisionLog.run(...params));
}
