import { now, json } from '../utils.js';
import { queueWrite } from '../db/batchWriter.js';
import { numSetting, boolSetting, strategyById } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();
const _updateHighWater = db.prepare(`UPDATE dry_run_positions SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ? WHERE id = ?`);

function checkProfitLockExit(position, pnlPercent) {
  const strat = strategyById(position.strategy_id);
  if (!strat?.profit_lock_enabled) return null;
  const tiers = strat.profit_lock_tiers || [];
  const dynamicBuffer = strat.profit_lock_dynamic_buffer ?? 30;

  let lockState = {};
  try { lockState = JSON.parse(position.profit_lock_state || '{}'); } catch { lockState = {}; }

  const highPnl = Math.max(lockState.high_pnl_pct || 0, pnlPercent);
  let floorPct = lockState.floor_pct || null;
  let tier = lockState.tier || 0;

  if (pnlPercent >= 80 || tier >= tiers.length) {
    const dynamicFloor = Math.max(50, highPnl - dynamicBuffer);
    floorPct = floorPct != null ? Math.max(floorPct, dynamicFloor) : dynamicFloor;
    tier = tiers.length;
  } else {
    for (let i = tiers.length - 1; i >= tier; i--) {
      if (pnlPercent >= tiers[i].trigger) {
        const newFloor = tiers[i].floor;
        floorPct = floorPct != null ? Math.max(floorPct, newFloor) : newFloor;
        tier = i + 1;
        break;
      }
    }
  }

  const newState = JSON.stringify({ high_pnl_pct: highPnl, floor_pct: floorPct, tier });
  db.prepare('UPDATE dry_run_positions SET profit_lock_state = ? WHERE id = ?').run(newState, position.id);

  if (floorPct != null && pnlPercent <= floorPct) {
    return { shouldExit: true, reason: `PROFIT_LOCK_FLOOR_${floorPct.toFixed(0)}` };
  }
  return null;
}

async function checkPartialTpLadder(position, pnlPercent, price, mcap) {
  const strat = strategyById(position.strategy_id);
  const tiers = strat?.partial_tp_tiers;
  if (!tiers?.length) return;

  let state = {};
  try { state = JSON.parse(position.partial_tp_state || '{}'); } catch { state = {}; }
  const executed = state.executed || [];

  for (const tier of tiers) {
    if (executed.includes(tier.trigger)) continue;
    if (pnlPercent < tier.trigger) continue;

    const pct = tier.sell_percent ?? tier.sell_pct ?? 50;
    console.log(`[position] ${position.id} partial TP ladder tier @${tier.trigger}% sell ${pct}%`);

    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (pct / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, `PARTIAL_TP_${tier.trigger}`);
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (pct / 100), sellAmount,
            json({ pct, tier: tier.trigger }), json({ pnlPercent, sell, tier }));
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial TP ladder sell failed: ${err.message}`);
      }
    }

    executed.push(tier.trigger);
    state.executed = executed;
    db.prepare('UPDATE dry_run_positions SET partial_tp_state = ? WHERE id = ?').run(JSON.stringify(state), position.id);
    break;
  }
}

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;

  // Max hold time check
  const strat = strategyById(position.strategy_id);
  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Partial TP Ladder (#1) — tiered sell system
  if (!exitReason && strat?.partial_tp_tiers?.length) {
    await checkPartialTpLadder(position, pnlPercent, price, mcap);
  } else if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    // Legacy binary partial TP
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Profit Lock (#4)
  if (!exitReason && strat?.profit_lock_enabled) {
    const lockResult = checkProfitLockExit(position, pnlPercent);
    if (lockResult?.shouldExit) exitReason = lockResult.reason;
  }

  // Standard exit checks (profit_lock suppresses standard SL/TP)
  if (!exitReason) {
    if (slHit && !strat?.profit_lock_enabled) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled && !strat?.profit_lock_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
    else if (slHit && strat?.profit_lock_enabled) exitReason = 'SL';
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  const posId = position.id;
  const armed = trailingArmed ? 1 : 0;
  queueWrite(() => _updateHighWater.run(highWaterMcap, highWaterPrice, armed, posId));

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) {
      await sendPositionExit(result);
      captureExitSnapshot(result);
    }
  }
}

function captureExitSnapshot(result) {
  try {
    const holdingMs = result.closed_at_ms && result.opened_at_ms
      ? Number(result.closed_at_ms) - Number(result.opened_at_ms)
      : null;
    let lockState = {};
    try { lockState = JSON.parse(result.profit_lock_state || '{}'); } catch { lockState = {}; }
    db.prepare(`
      INSERT INTO position_snapshots (position_id, phase, timestamp_ms, price, mcap, pnl_pct, exit_reason, holding_duration_ms, max_pnl_pct, data_json, created_at_ms)
      VALUES (?, 'exit', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id,
      now(),
      result.exit_price ?? result.price ?? null,
      result.exit_mcap ?? result.mcap ?? null,
      result.pnl_percent ?? result.pnlPercent ?? null,
      result.exitReason,
      holdingMs,
      lockState.high_pnl_pct ?? null,
      JSON.stringify({ strategy_id: result.strategy_id, execution_mode: result.execution_mode }),
      now(),
    );
  } catch (err) {
    console.log(`[snapshot] exit capture failed: ${err.message}`);
  }
}
