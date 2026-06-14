// Grafana-style time range resolution.
//
// The client sends `from`/`to` as either:
//   - relative tokens: "now", "now-15m", "now-1h", "now-7d", "now/d" ...
//   - absolute epoch milliseconds (numeric string)
//   - absolute ISO 8601 strings
//
// We resolve them to absolute epoch milliseconds on the server so the cache key
// and SQL are deterministic. Relative ranges are quantised (see cache.nowQuant)
// upstream of this module to keep keys stable across near-simultaneous calls.

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  M: 30 * 24 * 60 * 60 * 1000,
  y: 365 * 24 * 60 * 60 * 1000,
}

const RELATIVE_RE = /^now(?:([-+])(\d+)([smhdwMy]))?(?:\/([smhdwMy]))?$/

/**
 * @param {string} unit
 * @param {number} nowMs
 * @returns {number} epoch ms snapped to the start of the unit
 */
function startOfUnit(unit, nowMs) {
  const d = new Date(nowMs)
  switch (unit) {
    case 's':
      d.setMilliseconds(0)
      break
    case 'm':
      d.setSeconds(0, 0)
      break
    case 'h':
      d.setMinutes(0, 0, 0)
      break
    case 'd':
      d.setHours(0, 0, 0, 0)
      break
    case 'w': {
      d.setHours(0, 0, 0, 0)
      const day = d.getDay() // 0=Sun
      const diff = (day + 6) % 7 // ISO week starts Monday
      d.setDate(d.getDate() - diff)
      break
    }
    case 'M':
      d.setDate(1)
      d.setHours(0, 0, 0, 0)
      break
    case 'y':
      d.setMonth(0, 1)
      d.setHours(0, 0, 0, 0)
      break
    default:
      break
  }
  return d.getTime()
}

/**
 * Resolve one boundary token to epoch ms.
 * @param {string|number} token
 * @param {number} nowMs
 * @returns {number}
 */
export function resolveBoundary(token, nowMs) {
  if (typeof token === 'number' && Number.isFinite(token)) return token
  const raw = String(token).trim()

  // Pure numeric => epoch ms.
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }

  const m = RELATIVE_RE.exec(raw)
  if (m) {
    let value = nowMs
    if (m[1] && m[2] && m[3]) {
      const sign = m[1] === '-' ? -1 : 1
      value += sign * Number(m[2]) * UNIT_MS[m[3]]
    }
    if (m[4]) {
      value = startOfUnit(m[4], value)
    }
    return value
  }

  // ISO 8601 fallback.
  const parsed = Date.parse(raw)
  if (Number.isFinite(parsed)) return parsed

  throw new Error(`Unrecognised time token: ${raw}`)
}

/**
 * Resolve a {from, to} pair, returning absolute ms plus an `isLive` flag that
 * is true when the range tracks "now" (=> short cache TTL).
 * @param {string|number} from
 * @param {string|number} to
 * @param {number} nowMs
 */
export function resolveRange(from, to, nowMs) {
  const isLive =
    typeof to === 'string' && /now/.test(to)
  const fromMs = resolveBoundary(from, nowMs)
  const toMs = resolveBoundary(to, nowMs)
  if (!(toMs > fromMs)) {
    throw new Error('Invalid time range: `to` must be greater than `from`')
  }
  return { fromMs, toMs, isLive }
}

/**
 * Pick a sensible aggregation bucket (seconds) for a range so the edge
 * timelines stay readable without overloading the browser. Agent writes one
 * point per minute, so 60s is the natural floor.
 * @param {number} fromMs
 * @param {number} toMs
 * @param {number} [targetBuckets]
 */
export function pickBucketSeconds(fromMs, toMs, targetBuckets = 240) {
  const spanSec = Math.max(1, Math.round((toMs - fromMs) / 1000))
  const ideal = spanSec / targetBuckets
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]
  for (const step of steps) {
    if (step >= ideal) return step
  }
  return steps[steps.length - 1]
}
