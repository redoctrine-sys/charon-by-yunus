import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { now, json } from '../utils.js';
import { escapeHtml, fmtPct, fmtSol } from '../format.js';
import { db } from '../db/connection.js';
import { numSetting, boolSetting, setSetting, activeStrategy, setActiveStrategy, strategyById, updateStrategyConfig } from '../db/settings.js';
import { agentState, setState as setAgentState } from '../agentState.js';
import { manualSell, sellAll } from '../execution/router.js';
import { candidateById, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { storeDecision, logDecisionEvent } from '../db/decisions.js';
import {
  menuKeyboard,
  filtersText,
  filtersKeyboard,
  agentText,
  agentKeyboard,
  navKeyboard,
  mainMenuText,
  walletsText,
  positionsText,
  candidateButtons,
  positionButtons,
  strategyMenuText,
  strategyKeyboard,
} from './menus.js';
import { sendTelegram, sendBatch, sendPositionOpen } from './send.js';
import { candidateSummary, formatPosition } from './format.js';
import { refreshPosition } from '../execution/positions.js';
import { executeLiveSell } from '../execution/router.js';
import { openPositionCount, positionStats } from '../db/positions.js';
import { handleCallback, editMenuMessage } from './callbacks.js';
import { consumeNumericFilterInput } from './input.js';
import { runLearning, sendLessons } from '../learning/commands.js';

export async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text, msg.message_id)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/strategy')) {
    const parts = text.split(/\s+/);
    const id = parts[1];
    if (!id) {
      return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
    }
    const valid = ['sniper', 'dip_buy', 'smart_money', 'degen', 'profit_lock'];
    if (!valid.includes(id)) {
      return bot.sendMessage(chatId, `Unknown strategy. Valid: ${valid.join(', ')}`);
    }
    setActiveStrategy(id);
    return bot.sendMessage(chatId, strategyMenuText(), { parse_mode: 'HTML', ...strategyKeyboard() });
  }
  if (text.startsWith('/stratset')) {
    const parts = text.split(/\s+/);
    const [, id, key, ...rest] = parts;
    const value = rest.join(' ');
    if (!id || !key || !value) {
      return bot.sendMessage(chatId, 'Usage: /stratset <strategy_id> <key> <value>\n\nExample: /stratset sniper tp_percent 75\n\nKeys: tp_percent, sl_percent, position_size_sol, max_open_positions, min_mcap_usd, max_mcap_usd, min_holders, trailing_enabled, trailing_percent, partial_tp, partial_tp_at_percent, partial_tp_sell_percent, max_hold_ms, use_llm, llm_min_confidence, min_source_count, require_fee_claim, min_fee_claim_sol, min_gmgn_total_fee_sol, max_ath_distance_pct');
    }
    const strat = strategyById(id);
    if (!strat) return bot.sendMessage(chatId, `Strategy "${id}" not found.`);
    const numKeys = new Set(['tp_percent', 'sl_percent', 'position_size_sol', 'max_open_positions', 'min_mcap_usd', 'max_mcap_usd', 'min_holders', 'max_top20_holder_percent', 'trailing_percent', 'partial_tp_at_percent', 'partial_tp_sell_percent', 'max_hold_ms', 'llm_min_confidence', 'min_source_count', 'min_fee_claim_sol', 'min_gmgn_total_fee_sol', 'max_ath_distance_pct', 'token_age_max_ms', 'trending_min_volume_usd', 'trending_min_swaps', 'trending_max_rug_ratio', 'trending_max_bundler_rate', 'min_saved_wallet_holders', 'min_graduated_volume_usd']);
    const boolKeys = new Set(['trailing_enabled', 'partial_tp', 'use_llm', 'require_fee_claim']);
    const newConfig = { ...strat };
    delete newConfig.id;
    delete newConfig.name;
    if (numKeys.has(key)) {
      newConfig[key] = Number(value);
    } else if (boolKeys.has(key)) {
      newConfig[key] = value === 'true' || value === '1' || value === 'yes';
    } else {
      newConfig[key] = value;
    }
    updateStrategyConfig(id, newConfig);
    return bot.sendMessage(chatId, `Updated ${id}.${key} = ${value}\n\n${strategyMenuText()}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/startbot') || text.startsWith('/resume')) {
    setAgentState('running', 'Telegram command', msg.from?.username || 'user');
    return bot.sendMessage(chatId, `✅ Agent resumed. State: running`);
  }
  if (text.startsWith('/pausebot')) {
    setAgentState('paused', 'Telegram command', msg.from?.username || 'user');
    return bot.sendMessage(chatId, `⏸ Agent paused. New signals ignored, open positions still monitored.`);
  }
  if (text.startsWith('/stopbot_confirm')) {
    setAgentState('stopped', 'Telegram command', msg.from?.username || 'user');
    return bot.sendMessage(chatId, `🔴 Agent stopped. No new signals, no position monitoring.`);
  }
  if (text.startsWith('/stopbot')) {
    const count = openPositionCount();
    return bot.sendMessage(chatId, `⚠️ Stop agent? ${count} position(s) open.\nUse /stopbot_confirm to confirm.`);
  }
  if (text.startsWith('/status')) {
    const { controlPanelText } = await import('./menus.js');
    return bot.sendMessage(chatId, controlPanelText(), { parse_mode: 'HTML' });
  }
  if (text.startsWith('/hidepnl')) {
    const mode = text.split(/\s+/)[1] || 'stealth';
    setSetting('pnl_visibility', mode === 'history' ? 'hide_history' : 'stealth');
    return bot.sendMessage(chatId, `PnL visibility set to: ${mode === 'history' ? 'hide_history' : 'stealth'}`);
  }
  if (text.startsWith('/showpnl')) {
    setSetting('pnl_visibility', 'show_all');
    return bot.sendMessage(chatId, 'PnL visibility: show_all');
  }
  if (text.startsWith('/sellhalf')) {
    const posId = Number(text.split(/\s+/)[1]);
    if (!posId) return bot.sendMessage(chatId, 'Usage: /sellhalf <position_id>');
    try {
      const result = await manualSell(posId, 50, msg.from?.username || 'user');
      return bot.sendMessage(chatId, `💰 Sold 50% of position #${posId} · PnL ${fmtPct(result.pnl)}`, { parse_mode: 'HTML' });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Sell failed: ${err.message}`);
    }
  }
  if (text.startsWith('/sell ')) {
    const posId = Number(text.split(/\s+/)[1]);
    if (!posId) return bot.sendMessage(chatId, 'Usage: /sell <position_id>');
    try {
      const result = await manualSell(posId, 100, msg.from?.username || 'user');
      return bot.sendMessage(chatId, `💸 Sold 100% of position #${posId} · PnL ${fmtPct(result.pnl)}`, { parse_mode: 'HTML' });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Sell failed: ${err.message}`);
    }
  }
  if (text.startsWith('/sellall_confirm')) {
    const results = await sellAll(msg.from?.username || 'user');
    const lines = results.map(r => r.success ? `✅ #${r.id} ${fmtPct(r.pnl)}` : `❌ #${r.id} ${r.error}`);
    return bot.sendMessage(chatId, `Sell all complete:\n${lines.join('\n') || 'No open positions.'}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/sellall')) {
    const count = openPositionCount();
    return bot.sendMessage(chatId, `⚠️ Sell all ${count} open position(s)?\nUse /sellall_confirm to confirm.`);
  }
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

export async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

export async function sendPositions(chatId) {
  const rows = allPositions(12);
  const formatted = rows.map(formatPosition).filter(Boolean);
  const text = formatted.length ? formatted.join('\n\n') : 'No positions visible (check /showpnl).';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendPosition(chatId, id, query = null) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  if (query) return editMenuMessage(query, formatPosition(row), buttons);
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

export async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

export async function updatePositionRule(chatId, id, field, nextValue, query = null) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id, query);
}

export async function toggleTrailing(chatId, id, query = null) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id, query);
}

export function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'status', description: 'Show agent status & control panel' },
    { command: 'startbot', description: 'Start / resume agent' },
    { command: 'pausebot', description: 'Pause agent (positions still monitored)' },
    { command: 'stopbot', description: 'Stop agent (confirm required)' },
    { command: 'strategy', description: 'Show/switch strategy' },
    { command: 'stratset', description: 'Set strategy config (stratset id key value)' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'sell', description: 'Sell 100% of position (sell <id>)' },
    { command: 'sellhalf', description: 'Sell 50% of position (sellhalf <id>)' },
    { command: 'sellall', description: 'Sell all open positions (confirm required)' },
    { command: 'hidepnl', description: 'Hide PnL (hidepnl stealth|history)' },
    { command: 'showpnl', description: 'Show PnL again' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  const { TELEGRAM_TOPIC_ID } = await import('../config.js');
  await bot.sendMessage(chatId, mainMenuText(), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

function formatHoldMs(ms) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export async function sendPnl(chatId, query = null) {
  const all = positionStats();
  const d24h = positionStats({ windowMs: 24 * 60 * 60 * 1000 });
  const d7d = positionStats({ windowMs: 7 * 24 * 60 * 60 * 1000 });

  const lines = [
    '📊 <b>Charon PnL Report</b>',
    '',
    `Open positions: <b>${all.open}</b>`,
    '',
    '⬛ <b>All time</b>',
    `Trades: ${all.total} · Wins: ${all.wins} · Losses: ${all.losses}`,
    all.total ? `Win rate: <b>${fmtPct(all.winRate)}</b> · Avg PnL: <b>${fmtPct(all.avgPnlPct)}</b>` : 'No closed trades yet.',
    all.total ? `Total PnL: <b>${all.totalPnlSol >= 0 ? '+' : ''}${all.totalPnlSol.toFixed(4)} SOL</b>` : null,
    all.bestPnlPct != null ? `Best: +${fmtPct(all.bestPnlPct)} · Worst: ${fmtPct(all.worstPnlPct)}` : null,
    all.avgHoldMs != null ? `Avg hold: ${formatHoldMs(all.avgHoldMs)}` : null,
  ];

  if (d24h.total > 0) {
    lines.push('', '🕐 <b>Last 24h</b>');
    lines.push(`Trades: ${d24h.total} · Win rate: ${fmtPct(d24h.winRate)} · Avg: ${fmtPct(d24h.avgPnlPct)}`);
    lines.push(`PnL: ${d24h.totalPnlSol >= 0 ? '+' : ''}${d24h.totalPnlSol.toFixed(4)} SOL`);
  }

  if (d7d.total > 0 && d7d.total !== d24h.total) {
    lines.push('', '📅 <b>Last 7d</b>');
    lines.push(`Trades: ${d7d.total} · Win rate: ${fmtPct(d7d.winRate)} · Avg: ${fmtPct(d7d.avgPnlPct)}`);
    lines.push(`PnL: ${d7d.totalPnlSol >= 0 ? '+' : ''}${d7d.totalPnlSol.toFixed(4)} SOL`);
  }

  // Exit reason breakdown
  if (all.total > 0) {
    const reasons = Object.entries(all.byExitReason).sort((a, b) => b[1] - a[1]);
    if (reasons.length) {
      lines.push('', '🚪 <b>Exit reasons</b>');
      lines.push(reasons.map(([r, n]) => `${escapeHtml(r)}: ${n}`).join(' · '));
    }
  }

  // Per-strategy breakdown
  const stratEntries = Object.entries(all.byStrategy).sort((a, b) => b[1].total - a[1].total);
  if (stratEntries.length > 1) {
    lines.push('', '🎯 <b>By strategy</b>');
    for (const [strat, s] of stratEntries) {
      const wr = s.total ? (s.wins / s.total * 100) : 0;
      lines.push(`${escapeHtml(strat)}: ${s.total} trades · ${fmtPct(wr)} WR · ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(4)} SOL`);
    }
  }

  const text = lines.filter(l => l != null).join('\n');
  return query
    ? editMenuMessage(query, text, navKeyboard())
    : bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function savedWallets() {
  return db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
}
