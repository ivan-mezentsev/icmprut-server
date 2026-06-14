// Time helpers shared across the time picker and tooltips.

export const RELATIVE_PRESETS = [
  { label: 'Last 5 minutes', from: 'now-5m', to: 'now' },
  { label: 'Last 15 minutes', from: 'now-15m', to: 'now' },
  { label: 'Last 30 minutes', from: 'now-30m', to: 'now' },
  { label: 'Last 1 hour', from: 'now-1h', to: 'now' },
  { label: 'Last 3 hours', from: 'now-3h', to: 'now' },
  { label: 'Last 6 hours', from: 'now-6h', to: 'now' },
  { label: 'Last 12 hours', from: 'now-12h', to: 'now' },
  { label: 'Last 24 hours', from: 'now-24h', to: 'now' },
  { label: 'Last 2 days', from: 'now-2d', to: 'now' },
  { label: 'Last 7 days', from: 'now-7d', to: 'now' },
  { label: 'Last 30 days', from: 'now-30d', to: 'now' },
]

export const DEFAULT_RANGE = { from: 'now-15m', to: 'now' }

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
}

const RELATIVE_RE = /^now(?:-(\d+)([smhdw]))?$/

export function isRelative(token) {
  return typeof token === 'string' && token.startsWith('now')
}

/** Resolve a boundary token to epoch ms (client-side, for previews/sliders). */
export function resolveBoundaryMs(token, nowMs = Date.now()) {
  if (typeof token === 'number') return token
  const raw = String(token).trim()
  if (/^-?\d+$/.test(raw)) return Number(raw)
  const m = RELATIVE_RE.exec(raw)
  if (m) {
    if (!m[1]) return nowMs
    return nowMs - Number(m[1]) * UNIT_MS[m[2]]
  }
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : nowMs
}

const pad = (n) => String(n).padStart(2, '0')

/** Local timestamp like "2026-06-13 12:34:56". */
export function fmtAbsolute(ms) {
  const d = new Date(ms)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** Compact time like "12:34:56" or "06-13 12:34" for wider ranges. */
export function fmtClock(ms, withDate = false) {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time
}

/** Human label for a range, relative-aware. */
export function describeRange(from, to) {
  const preset = RELATIVE_PRESETS.find((p) => p.from === from && p.to === to)
  if (preset) return preset.label
  if (isRelative(from) || isRelative(to)) return `${from} → ${to}`
  return `${fmtAbsolute(Number(from))} → ${fmtAbsolute(Number(to))}`
}

/** Convert epoch ms to a value usable by <input type="datetime-local">. */
export function msToLocalInput(ms) {
  const d = new Date(ms - d0(ms))
  return d.toISOString().slice(0, 19)
}

function d0(ms) {
  // timezone offset in ms (so the local input shows local wall clock)
  return new Date(ms).getTimezoneOffset() * 60 * 1000
}

/** Convert a datetime-local input value to epoch ms (local time). */
export function localInputToMs(value) {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return Date.now()
  return ms
}

/**
 * Parse a fixed 24h "YYYY-MM-DD HH:mm[:ss]" string as LOCAL wall-clock time.
 * Returns epoch ms, or null if it doesn't match (so the UI can flag it).
 * Deliberately strict & locale-independent — no native calendar, full keyboard.
 */
const ABS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
export function parseAbsoluteLocal(value) {
  const m = ABS_RE.exec(String(value).trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    0,
  )
  // Reject impossible values (e.g. month 13) that Date would roll over.
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d) ||
    date.getHours() !== Number(h) ||
    date.getMinutes() !== Number(mi)
  ) {
    return null
  }
  return date.getTime()
}

/** Format epoch ms as the strict 24h input string used by the picker. */
export function fmtAbsoluteInput(ms) {
  return fmtAbsolute(ms)
}

export function fmtDuration(ms) {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const h = Math.round(min / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
