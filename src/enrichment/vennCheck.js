/**
 * Venn Lock signal computation from available on-chain / enrichment data.
 *
 * Each check carries an `available` flag.
 * - available=true  → data present, check result is meaningful
 * - available=false → data absent, check is SKIPPED (not counted against score)
 *
 * Hard pre-filter only blocks when check is available AND fails.
 * LLM backstop evaluates unavailable checks via strategy hint.
 */

function check(ok, available, extra = {}) {
  return { ok: available ? ok : null, available, ...extra };
}

export function computeVennSignals(candidate, strat = {}) {
  const c = candidate;

  // ── Data availability detection ─────────────────────────────────────────────
  const hasSocialSource = Boolean(c.jupiterAsset || c.gmgn || c.graduation || c.trending);
  const hasTrendingData = Boolean(c.trending);
  const hasBundlerData  = hasTrendingData && Number(c.trending?.bundler_rate ?? -1) >= 0;
  const hasVolStats     = Number(c.trending?.stats1h?.buyVolume ?? 0) + Number(c.trending?.stats1h?.sellVolume ?? 0) > 0;
  const hasChartData    = c.chart != null && (c.chart.distanceFromAthPercent != null || c.chart.belowRangeHighPercent != null);
  const hasHolderData   = Boolean(c.holders?.top20?.length || c.holders?.maxHolderPercent != null);
  const hasNarrativeData = c.twitterNarrative != null;

  // 1. Social presence
  const hasSocial = Boolean(c.token?.twitter || c.token?.telegram || c.token?.website);

  // 2. Bundle rate (trending.bundler_rate 0–1 → 0–100%)
  const bundlerRateRaw = Number(c.trending?.bundler_rate ?? 0);
  const bundlePercent  = Math.round(bundlerRateRaw * 1000) / 10;
  const bundleMaxPct   = strat.bundle_max_percent ?? 35;
  const bundleOk       = bundlePercent <= bundleMaxPct;

  // 3. Volume spike 3x average (5m vs 1h/12)
  const vol5m  = Number(c.trending?.stats5m?.buyVolume ?? 0) + Number(c.trending?.stats5m?.sellVolume ?? 0);
  const vol1h  = Number(c.trending?.stats1h?.buyVolume ?? 0) + Number(c.trending?.stats1h?.sellVolume ?? 0);
  const avgPer5m = vol1h > 0 ? vol1h / 12 : null;
  const spikeRatio = avgPer5m && avgPer5m > 0 && vol5m > 0
    ? Math.round((vol5m / avgPer5m) * 100) / 100
    : null;
  const volumeSpike3x = spikeRatio !== null && spikeRatio >= 3.0;

  // 4. Token age
  const ageMs   = c.createdAtMs ? Date.now() - Number(c.createdAtMs) : null;
  const ageMins = ageMs !== null ? Math.round(ageMs / 60000) : null;
  const isFresh   = ageMs !== null && ageMs < 3_600_000;
  const isSleeper = ageMs !== null && ageMs >= 3_600_000 && ageMs < 86_400_000;
  let entryMode = ageMs === null ? 'UNKNOWN' : isFresh ? 'FRESH' : isSleeper ? 'SLEEPER' : 'TOO_OLD';

  // 5. ATH distance
  const athDistPct = hasChartData
    ? (Number(c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent) || null)
    : null;

  // Fresh: token must have dumped ≥60% from ATH (snipers exited)
  const freshDumpOk = isFresh && hasChartData ? (athDistPct !== null && athDistPct <= -60) : null;

  // Sleeper: Fibonacci 0.786 proxy — ATH dist in -65% to -90% range
  const atFibProxy = isSleeper && hasChartData
    ? (athDistPct !== null && athDistPct <= -65 && athDistPct >= -90)
    : null;

  // 6. Narrative
  const hasNarrative = hasNarrativeData
    ? Boolean(c.twitterNarrative?.hasTrending || Number(c.twitterNarrative?.tweetCount) > 0)
    : null;

  // 7. Holder concentration (cluster proxy: max single holder ≤ cluster_max_percent)
  const top20     = c.holders?.top20 ?? [];
  const maxHolder = hasHolderData
    ? (c.holders?.maxHolderPercent ?? (top20.length > 0 ? Number(top20[0]?.percent ?? 100) : null))
    : null;
  const clusterMaxPct = strat.cluster_max_percent ?? 5;
  const holderOk = maxHolder !== null ? maxHolder <= clusterMaxPct : null;

  // ── Weighted score (for LLM context and logging) ────────────────────────────
  // Only available checks count. Threshold: 87.5% (blueprint's 7/8).
  const scoredChecks = [
    { name: 'social',          ok: hasSocial,    available: hasSocialSource },
    { name: 'bundle',          ok: bundleOk,     available: hasBundlerData  },
    { name: 'volume_spike_3x', ok: volumeSpike3x, available: hasVolStats && spikeRatio !== null },
    { name: 'narrative',       ok: hasNarrative ?? false, available: hasNarrativeData },
    { name: 'holder_conc',     ok: holderOk ?? false,     available: hasHolderData && maxHolder !== null },
  ];
  if (isFresh  && hasChartData) scoredChecks.push({ name: 'fresh_dump',  ok: freshDumpOk ?? false,  available: true });
  if (isSleeper && hasChartData) scoredChecks.push({ name: 'fib_proxy',  ok: atFibProxy ?? false,   available: true });

  const available = scoredChecks.filter(s => s.available);
  const passed    = available.filter(s => s.ok).length;
  const vennScore = available.length > 0 ? passed / available.length : null;

  return {
    entry_mode: entryMode,
    token_age_mins: ageMins,
    venn_score: vennScore !== null ? { passed, total: available.length, ratio: Math.round(vennScore * 100) / 100 } : null,
    social:    check(hasSocial,    hasSocialSource, { twitter: Boolean(c.token?.twitter), telegram: Boolean(c.token?.telegram), website: Boolean(c.token?.website) }),
    bundle:    check(bundleOk,     hasBundlerData,  { percent: bundlePercent, max: bundleMaxPct }),
    volume_spike: check(volumeSpike3x, hasVolStats && spikeRatio !== null, { ratio: spikeRatio, threshold: 3.0 }),
    fresh_dump:   check(freshDumpOk ?? false, isFresh && hasChartData, { ath_dist_pct: athDistPct, threshold: -60 }),
    fibonacci_proxy: check(atFibProxy ?? false, isSleeper && hasChartData, { ath_dist_pct: athDistPct, note: 'proxy: ath_dist -65% to -90% ≈ 0.786 fib' }),
    narrative:    check(hasNarrative ?? false, hasNarrativeData),
    holder_concentration: check(holderOk ?? false, hasHolderData && maxHolder !== null, { max_holder_pct: maxHolder, threshold: clusterMaxPct }),
    // External checks — not available locally, delegated to LLM
    dev_analysis:    { ok: null, available: false },
    global_fee:      { ok: null, available: false },
    revoke:          { ok: null, available: false },
    deepnets:        { ok: null, available: false },
    token_similarity: { ok: null, available: false },
  };
}

export function vennFilterFailures(candidate, strat) {
  const signals = computeVennSignals(candidate, strat);
  const failures = [];

  // Only fail when data IS available AND check fails
  if (strat.social_min_accounts > 0 && signals.social.available && signals.social.ok === false) {
    failures.push('venn:social: no Twitter/Telegram/Website found');
  }
  if (strat.bundle_max_percent != null && signals.bundle.available && signals.bundle.ok === false) {
    failures.push(`venn:bundle: ${signals.bundle.percent?.toFixed(0)}% > max ${strat.bundle_max_percent}%`);
  }
  // Age is always computable from createdAtMs — hard reject too-old tokens
  if (signals.entry_mode === 'TOO_OLD') {
    failures.push(`venn:age: ${signals.token_age_mins}m > 1440m max`);
  }

  return { failures, signals };
}
