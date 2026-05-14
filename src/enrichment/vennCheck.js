/**
 * Venn Lock signal computation from available on-chain / enrichment data.
 * External checks (dev analysis, revoke, deepnets, token similarity) require
 * APIs not integrated — those are flagged as unavailable and delegated to LLM.
 */

export function computeVennSignals(candidate, strat = {}) {
  const c = candidate;

  // 1. Social presence
  const hasSocial = Boolean(c.token?.twitter || c.token?.telegram || c.token?.website);

  // 2. Bundle rate (trending.bundler_rate is 0-1 scale)
  const bundlerRateRaw = Number(c.trending?.bundler_rate ?? 0);
  const bundlePercent = Math.round(bundlerRateRaw * 1000) / 10; // 0-100%
  const bundleMaxPct = strat.bundle_max_percent ?? 35;
  const bundleOk = bundlePercent <= bundleMaxPct;

  // 3. Volume spike: 3x average (5m volume vs hourly/12)
  const vol5m = Number(c.trending?.stats5m?.buyVolume ?? 0) + Number(c.trending?.stats5m?.sellVolume ?? 0);
  const vol1h = Number(c.trending?.stats1h?.buyVolume ?? 0) + Number(c.trending?.stats1h?.sellVolume ?? 0);
  const avgPer5m = vol1h > 0 ? vol1h / 12 : null;
  const volumeSpikeRatio = avgPer5m && avgPer5m > 0 && vol5m > 0 ? Math.round((vol5m / avgPer5m) * 100) / 100 : null;
  const volumeSpike3x = volumeSpikeRatio !== null && volumeSpikeRatio >= 3.0;

  // 4. Token age classification
  const ageMs = c.createdAtMs ? Date.now() - Number(c.createdAtMs) : null;
  const ageMins = ageMs !== null ? Math.round(ageMs / 60000) : null;
  const isFresh = ageMs !== null && ageMs < 3_600_000;
  const isSleeper = ageMs !== null && ageMs >= 3_600_000 && ageMs < 86_400_000;

  // 5. ATH distance
  const athDistPct = Number(c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent ?? 0) || null;

  // Fresh mode: needs -60% dump from ATH (sniper exit signal)
  const freshDumpOk = isFresh ? (athDistPct !== null && athDistPct <= -60) : null;

  // Sleeper Fibonacci proxy: price at ~78.6% retracement
  // Without candle swing-low data, use ATH distance range -65% to -90% as proxy
  const atFibProxy = isSleeper && athDistPct !== null
    ? (athDistPct <= -65 && athDistPct >= -90)
    : null;

  // 6. Narrative
  const hasNarrative = Boolean(c.twitterNarrative?.hasTrending || Number(c.twitterNarrative?.tweetCount) > 0);

  // 7. Holder concentration (cluster proxy)
  const top20 = c.holders?.top20 ?? [];
  const maxHolder = c.holders?.maxHolderPercent ?? (top20.length > 0 ? Number(top20[0]?.percent ?? 100) : 100);
  const clusterMaxPct = strat.cluster_max_percent ?? 5;
  // strict cluster check: max single holder ≤ cluster_max_percent
  const holderOk = maxHolder <= clusterMaxPct;

  // Entry mode
  let entryMode = 'UNKNOWN';
  if (isFresh) entryMode = 'FRESH';
  else if (isSleeper) entryMode = 'SLEEPER';
  else if (ageMs !== null) entryMode = 'TOO_OLD';

  return {
    entry_mode: entryMode,
    token_age_mins: ageMins,
    social: {
      ok: hasSocial,
      twitter: Boolean(c.token?.twitter),
      telegram: Boolean(c.token?.telegram),
      website: Boolean(c.token?.website),
    },
    bundle: {
      ok: bundleOk,
      percent: bundlePercent,
      max: bundleMaxPct,
    },
    volume_spike: {
      ok: volumeSpike3x,
      ratio: volumeSpikeRatio,
      threshold: 3.0,
    },
    fresh_dump: {
      ok: freshDumpOk,
      ath_dist_pct: athDistPct,
      threshold: -60,
    },
    fibonacci_proxy: {
      ok: atFibProxy,
      ath_dist_pct: athDistPct,
      note: 'proxy: ath_dist -65% to -90% ≈ 0.786 fib retracement',
    },
    narrative: {
      ok: hasNarrative,
    },
    holder_concentration: {
      ok: holderOk,
      max_holder_pct: maxHolder,
      threshold: clusterMaxPct,
    },
    // External checks — not available, delegated to LLM
    dev_analysis: { available: false },
    global_fee: { available: false },
    revoke: { available: false },
    deepnets: { available: false },
    token_similarity: { available: false },
  };
}

export function vennFilterFailures(candidate, strat) {
  const signals = computeVennSignals(candidate, strat);
  const failures = [];

  if (strat.social_min_accounts > 0 && !signals.social.ok) {
    failures.push('venn:social: no Twitter/Telegram/Website found');
  }
  if (strat.bundle_max_percent != null && !signals.bundle.ok) {
    failures.push(`venn:bundle: ${signals.bundle.percent.toFixed(0)}% > max ${strat.bundle_max_percent}%`);
  }
  if (signals.entry_mode === 'TOO_OLD') {
    failures.push(`venn:age: ${signals.token_age_mins}m > 1440m max`);
  }

  return { failures, signals };
}
