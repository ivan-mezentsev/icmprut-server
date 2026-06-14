// Centralised runtime configuration, sourced from environment variables.
// All values have sane defaults for local development and are meant to be
// overridden via the environment (see .env_example) in production.

function envStr(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '' || value === '-') return fallback
  return value
}

function envInt(name, fallback) {
  const raw = envStr(name, undefined)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const config = {
  // HTTP listener of this UI/API server.
  host: envStr('ICMPRUT_SERVER_HOST', '0.0.0.0'),
  port: envInt('ICMPRUT_SERVER_PORT', 3089),

  // Upstream InfluxDB 3 Core. Override via the environment in any real setup.
  influx: {
    url: envStr('ICMPRUT_INFLUXDB_URL', 'http://127.0.0.1:8181').replace(/\/+$/, ''),
    token: envStr('ICMPRUT_INFLUXDB_TOKEN', ''),
    db: envStr('ICMPRUT_INFLUXDB_DB', 'icmprut'),
    // Per-request upstream timeout (ms).
    timeoutMs: envInt('ICMPRUT_INFLUXDB_TIMEOUT_MS', 30000),
  },

  // Query cache + coalescing tuning. Built for the future multi-user setup:
  // many clients asking for the same window must hit InfluxDB once.
  cache: {
    // TTL for "live" queries whose range ends at ~now.
    liveTtlMs: envInt('ICMPRUT_CACHE_LIVE_TTL_MS', 10000),
    // TTL for fully historical queries (immutable result).
    historyTtlMs: envInt('ICMPRUT_CACHE_HISTORY_TTL_MS', 300000),
    // Max cached entries (LRU eviction).
    maxEntries: envInt('ICMPRUT_CACHE_MAX_ENTRIES', 512),
    // Quantisation of "now" so near-simultaneous live requests share a key.
    nowQuantMs: envInt('ICMPRUT_CACHE_NOW_QUANT_MS', 10000),
    // "Settling" window: data whose timestamp is newer than (now - this) may
    // still receive late writes (an offline agent backfilling past windows),
    // so any range ending inside it gets the short live TTL even if absolute.
    settleMs: envInt('ICMPRUT_CACHE_SETTLE_MS', 600000),
  },

  // Where the built SPA lives (relative to project root).
  staticDir: envStr('ICMPRUT_STATIC_DIR', 'dist'),

  nodeEnv: envStr('NODE_ENV', 'development'),
}

export default config
