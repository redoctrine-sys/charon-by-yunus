import { now, json, firstPositiveNumber } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount, openPositions } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  const swap = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: selectedRow.candidate.token.mint,
    amount: amountLamports,
  });
  if (!swap.outputAmount) {
    swap.outputAmount = await fetchLiveTokenBalance(selectedRow.candidate.token.mint) || swap.outputAmount;
  }
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, swap },
  });
  await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, swap },
    });
    return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

const manualSellInProgress = new Set();

export async function manualSell(positionId, sellPercent = 100, triggeredBy = 'telegram') {
  if (manualSellInProgress.has(positionId)) throw new Error('Sell already in progress for this position.');
  manualSellInProgress.add(positionId);
  try {
    const pos = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
    if (!pos || pos.status !== 'open') throw new Error('Open position not found.');
    const asset = await fetchJupiterAsset(pos.mint);
    const freshPrice = firstPositiveNumber(asset?.usdPrice, pos.high_water_price, pos.entry_price);
    const freshMcap = firstPositiveNumber(asset?.mcap, asset?.fdv, pos.high_water_mcap, pos.entry_mcap);
    const freshPnl = pos.entry_mcap ? (Number(freshMcap) / Number(pos.entry_mcap) - 1) * 100 : 0;
    const pct = Math.min(100, Math.max(1, sellPercent));
    let sell = null;
    if (pos.execution_mode === 'live' && pos.token_amount_raw) {
      const rawSell = Math.floor(Number(pos.token_amount_raw) * (pct / 100));
      if (rawSell > 0) {
        sell = await executeLiveSell({ ...pos, token_amount_raw: String(rawSell) }, `MANUAL_${triggeredBy.toUpperCase()}`);
        if (pct < 100) {
          const remaining = Number(pos.token_amount_raw) - rawSell;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), positionId);
        }
      }
    }
    const sizeSol = Number(pos.size_sol) * (pct / 100);
    const pnlSol = sizeSol * freshPnl / 100;
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, pos.mint, now(), freshPrice, freshMcap, sizeSol, pos.token_amount_est, `MANUAL_${pct}pct`, json({ pct, pnlPercent: freshPnl, pnlSol, triggeredBy, sell }));
    if (pct === 100) {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
        ${sell?.signature ? ', exit_signature = ?' : ''}
        WHERE id = ?
      `).run(...[now(), freshPrice, freshMcap, `MANUAL_${triggeredBy.toUpperCase()}`, freshPnl, pnlSol, ...(sell?.signature ? [sell.signature] : []), positionId]);
    }
    return { success: true, pnl: freshPnl, sell };
  } finally {
    manualSellInProgress.delete(positionId);
  }
}

export async function sellAll(triggeredBy = 'telegram') {
  const positions = openPositions();
  const results = [];
  for (const pos of positions) {
    try {
      const result = await manualSell(pos.id, 100, triggeredBy);
      results.push({ id: pos.id, mint: pos.mint, success: true, pnl: result.pnl });
    } catch (err) {
      results.push({ id: pos.id, mint: pos.mint, success: false, error: err.message });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
