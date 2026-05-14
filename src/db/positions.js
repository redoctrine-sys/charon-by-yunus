import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

function captureEntrySnapshot(positionId, candidate, decision, strategyId) {
  try {
    const price = Number(candidate.metrics?.priceUsd || 0) || null;
    const mcap = Number(candidate.metrics?.marketCapUsd || candidate.metrics?.graduatedMarketCapUsd || 0) || null;
    db.prepare(`
      INSERT INTO position_snapshots (position_id, phase, timestamp_ms, price, mcap, pnl_pct, data_json, created_at_ms)
      VALUES (?, 'entry', ?, ?, ?, 0, ?, ?)
    `).run(
      positionId,
      now(),
      price,
      mcap,
      JSON.stringify({ strategy_id: strategyId, llm_confidence: decision?.confidence, llm_verdict: decision?.verdict }),
      now(),
    );
  } catch { /* never block entry */ }
}

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function positionStats({ windowMs = null, strategyId = null } = {}) {
  const conditions = ["status = 'closed'"];
  const params = [];
  if (windowMs) { conditions.push('closed_at_ms >= ?'); params.push(Date.now() - windowMs); }
  if (strategyId) { conditions.push('strategy_id = ?'); params.push(strategyId); }
  const where = conditions.join(' AND ');

  const closed = db.prepare(`SELECT * FROM dry_run_positions WHERE ${where}`).all(...params);
  const open = db.prepare('SELECT * FROM dry_run_positions WHERE status = ?').all('open');

  if (!closed.length) {
    return {
      total: 0, open: open.length, wins: 0, losses: 0, winRate: 0,
      totalPnlPct: 0, avgPnlPct: 0, totalPnlSol: 0,
      bestPnlPct: null, worstPnlPct: null,
      avgHoldMs: null, byExitReason: {}, byStrategy: {},
    };
  }

  let wins = 0, totalPnlPct = 0, totalPnlSol = 0, totalHoldMs = 0, holdCount = 0;
  let bestPnlPct = -Infinity, worstPnlPct = Infinity;
  const byExitReason = {};
  const byStrategy = {};

  for (const p of closed) {
    const pnl = Number(p.pnl_percent ?? 0);
    const pnlSol = Number(p.pnl_sol ?? 0);
    if (pnl > 0) wins++;
    totalPnlPct += pnl;
    totalPnlSol += pnlSol;
    if (pnl > bestPnlPct) bestPnlPct = pnl;
    if (pnl < worstPnlPct) worstPnlPct = pnl;
    const holdMs = p.closed_at_ms && p.opened_at_ms ? Number(p.closed_at_ms) - Number(p.opened_at_ms) : null;
    if (holdMs != null) { totalHoldMs += holdMs; holdCount++; }
    const reason = p.exit_reason || 'unknown';
    byExitReason[reason] = (byExitReason[reason] || 0) + 1;
    const strat = p.strategy_id || 'unknown';
    if (!byStrategy[strat]) byStrategy[strat] = { total: 0, wins: 0, pnlPct: 0, pnlSol: 0 };
    byStrategy[strat].total++;
    if (pnl > 0) byStrategy[strat].wins++;
    byStrategy[strat].pnlPct += pnl;
    byStrategy[strat].pnlSol += pnlSol;
  }

  return {
    total: closed.length,
    open: open.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    totalPnlPct,
    avgPnlPct: closed.length ? totalPnlPct / closed.length : 0,
    totalPnlSol,
    bestPnlPct: bestPnlPct === -Infinity ? null : bestPnlPct,
    worstPnlPct: worstPnlPct === Infinity ? null : worstPnlPct,
    avgHoldMs: holdCount ? totalHoldMs / holdCount : null,
    byExitReason,
    byStrategy,
  };
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    captureEntrySnapshot(positionId, candidate, decision, strat.id);
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    captureEntrySnapshot(positionId, candidate, decision, strat.id);
    return positionId;
  })();
}
