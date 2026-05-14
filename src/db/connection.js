import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
    CREATE TABLE IF NOT EXISTS agent_current_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL DEFAULT 'running',
      changed_at_ms INTEGER NOT NULL DEFAULT 0,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_state_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      old_state TEXT NOT NULL,
      new_state TEXT NOT NULL,
      reason TEXT,
      triggered_by TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      phase TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      pnl_pct REAL,
      exit_reason TEXT,
      exit_triggered_by TEXT,
      holding_duration_ms INTEGER,
      max_pnl_pct REAL,
      data_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_position ON position_snapshots(position_id);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'sniper'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('dry_run_positions', 'profit_lock_state', 'TEXT');
  ensureColumn('dry_run_positions', 'partial_tp_state', 'TEXT');
  ensureColumn('price_alerts', 'stoch_rsi_k', 'REAL');
  ensureColumn('price_alerts', 'stoch_rsi_d', 'REAL');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
  db.prepare(`INSERT OR IGNORE INTO agent_current_state (id, state, changed_at_ms) VALUES (1, 'running', ?)`).run(Date.now());

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '5',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    pnl_visibility: 'show_all',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  stratInsert.run('sniper', 'Sniper', 1, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 3600000,
    min_mcap_usd: 7000,
    max_mcap_usd: 200000,
    min_fee_claim_sol: 0.5,
    min_gmgn_total_fee_sol: 10,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: true,
    trailing_percent: 20,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 50,
  }), ts);

  stratInsert.run('dip_buy', 'Dip Buy', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 25000,
    max_mcap_usd: 500000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -40,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 3,
    tp_percent: 30,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 60,
  }), ts);

  stratInsert.run('smart_money', 'Smart Money', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 10000,
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 1000,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 100,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,
    max_open_positions: 3,
    tp_percent: 100,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 100,
    partial_tp_sell_percent: 50,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 70,
  }), ts);

  stratInsert.run('profit_lock', 'Profit Lock', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.4,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.05,
    max_open_positions: 7,
    tp_percent: 9999,
    sl_percent: -20,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 70,
    profit_lock_enabled: true,
    profit_lock_tiers: [
      { trigger: 15, floor: 5 },
      { trigger: 40, floor: 20 },
      { trigger: 80, floor: 50 },
    ],
    profit_lock_dynamic_buffer: 30,
  }), ts);

  stratInsert.run('degen', 'Degen', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.5,
    trending_max_bundler_rate: 0.7,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 30,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: false,
    llm_min_confidence: 0,
  }), ts);

  stratInsert.run('venn_lock', 'Venn Lock', 0, JSON.stringify({
    entry_mode: 'adaptive',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 86400000,
    min_mcap_usd: 5000,
    max_mcap_usd: 100000,
    position_size_sol: 0.05,
    max_open_positions: 5,
    tp_percent: 9999,
    sl_percent: -20,
    trailing_enabled: false,
    trailing_percent: 0,
    profit_lock_enabled: true,
    profit_lock_tiers: [
      { trigger: 15, floor: 5 },
      { trigger: 40, floor: 20 },
      { trigger: 80, floor: 50 },
    ],
    profit_lock_dynamic_buffer: 30,
    partial_tp: true,
    partial_tp_tiers: [
      { trigger: 100, sell_pct: 50 },
      { trigger: 200, sell_pct: 25 },
      { trigger: 300, sell_pct: 25 },
    ],
    use_llm: true,
    llm_min_confidence: 75,
    // Venn Irisan filters
    social_min_accounts: 1,
    dev_holding_max_percent: 5,
    cluster_max_percent: 5,
    bundle_max_percent: 35,
    trending_max_bundler_rate: 0.35,
    trending_max_rug_ratio: 0.3,
    min_holders: 0,
    max_top20_holder_percent: 50,
    max_ath_distance_pct: 0,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    min_saved_wallet_holders: 0,
    // Venn Komplementer
    fibonacci_entry_level: 0.786,
    volume_3x_average_trigger: true,
    narrative_strength_min: 'medium',
    holder_stacked_min_percent: 30,
    holder_wallet_age_min_days: 3,
    holder_growth_rate_min: 0.05,
    volume_sustainability_check: true,
    cabal_vs_organic_detection: true,
    bundle_exit_monitoring: true,
    max_daily_trades: 8,
    cooldown_after_loss_ms: 1800000,
    compounding_enabled: true,
    compounding_percent: 35,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    llm_strategy_hint: [
      'STRATEGY: Venn Lock — Golden irisian dari 4 alpha hunters (Safety+Patience+Narrative+System) dengan profit lock exit.',
      'Candidate includes "venn_signals" field. Use it to evaluate Venn Irisan score.',
      'VENN IRISAN (score 8 checks, need 7/8):',
      '  1. social.ok: token has Twitter/Telegram/Website.',
      '  2. dev: Holding ≤5%, history <5 tokens, migration success ≥25% (infer from available data or assume OK if no red flags).',
      '  3. holder_concentration.ok: top holder ≤5% (cluster check).',
      '  4. bundle.ok: bundler ratio ≤35%.',
      '  5. global_fee: fee ≥1 SOL organic volume (infer from trending volume / fee claim data).',
      '  6. revoke: mint/freeze/LP revoked (infer from token metadata or assume unknown).',
      '  7. deepnets: risk ≤Risky (infer from rug_ratio, bundler_rate, other signals).',
      '  8. token_similarity: OG token, not copycat (infer from name/symbol patterns).',
      'ENTRY MODE from venn_signals.entry_mode:',
      '  FRESH (<1h): Only buy if venn_signals.fresh_dump.ok=true (dumped -60%+ from ATH) AND volume organic AND narrative matches meta. If not dumped yet, WATCH.',
      '  SLEEPER (1-24h): Only buy if venn_signals.fibonacci_proxy.ok=true (near 0.786 fib) AND volume_spike.ok=true (3x avg) AND narrative sustains AND bundle mostly exited.',
      'CONFIDENCE BOOSTERS: venn score 8/8 +15, volume_spike.ratio >5 +10, smart_wallet.has_smart_money +10, narrative trending +5.',
      'CONFIDENCE PENALTIES: venn score <7/8 -30 (likely PASS), bundle.percent >50 -25, fresh_dump.ok=false in FRESH mode -20.',
      'EXIT: profit_lock tiers handle exit, no fixed TP. suggested_tp_percent=null.',
      'SPECIAL RULES: If narrative faded, lower confidence. If bundle dumping fast, prefer PASS.',
    ].join(' '),
  }), ts);

  stratInsert.run('sniper_lock', 'Sniper Lock', 0, JSON.stringify({
    entry_mode: 'immediate',
    // Age limit is OFF — entry mode is determined adaptively by the LLM per llm_strategy_hint
    token_age_max_ms: 0,
    min_source_count: 2,
    // Fee claim is only required for fresh tokens (<1h); enforced via LLM hint, not hard filter
    require_fee_claim: false,
    min_mcap_usd: 7000,
    max_mcap_usd: 100000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
    position_size_sol: 0.1,
    max_open_positions: 5,
    tp_percent: 9999,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 0,
    partial_tp: false,
    partial_tp_at_percent: 0,
    partial_tp_sell_percent: 0,
    max_hold_ms: 0,
    use_llm: true,
    llm_min_confidence: 60,
    // Profit Lock exit system — replaces static TP/trailing
    profit_lock_enabled: true,
    profit_lock_tiers: [
      { trigger: 15, floor: 5 },
      { trigger: 40, floor: 20 },
      { trigger: 80, floor: 50 },
    ],
    profit_lock_dynamic_buffer: 30,
    // LLM receives this hint so it applies age-aware entry logic and confidence metrics
    llm_strategy_hint: [
      'STRATEGY: Sniper Lock (adaptive entry + profit-lock exit).',
      'Each candidate includes a "sniper_lock_signals" field with pre-computed confidence signals — use them.',
      'ENTRY MODE: Check sniper_lock_signals.entry_mode.',
      '  - FRESH (age <60min): require fee_claim evidence, 2+ signals. Entry is aggressive.',
      '  - CONSOLIDATION (age >60min): require sniper_lock_signals.volume_spike.is_spike=true. Reject if no spike.',
      'CONFIDENCE BOOSTERS (raise your confidence score when present):',
      '  1. volume_spike.spike_ratio >= 2.0 and is_spike=true: strong buy momentum, add +15 confidence.',
      '  2. top10_concentration.concentration_risk=LOW (top10 hold < 35%): low dump risk, add +10 confidence.',
      '  3. stoch_rsi_proxy.oversold_proxy=true: price near 24h low, likely bouncing, add +10 confidence.',
      '  4. smart_wallet.has_smart_money=true: validated smart wallet/KOL entry confirmed, add +15 confidence.',
      'CONFIDENCE PENALTIES (lower your score):',
      '  - top10_concentration.concentration_risk=HIGH (> 60%): high dump risk, subtract -20 confidence.',
      '  - volume_spike.spike_ratio < 1.0 in CONSOLIDATION mode: no real momentum, penalize heavily.',
      'EXIT: Profit Lock tiers handle exit — do NOT set TP. Override to PASS if smart_wallet shows dumps.',
    ].join(' '),
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function checkpoint() {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
}

// Periodic WAL checkpoint every 5 minutes to prevent unbounded WAL growth
setInterval(checkpoint, 5 * 60 * 1000).unref();

process.once('exit', () => { try { checkpoint(); db.close(); } catch { /* ignore */ } });
process.once('SIGINT', () => { checkpoint(); process.exit(0); });
process.once('SIGTERM', () => { checkpoint(); process.exit(0); });
