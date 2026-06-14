// Shared constants/helpers for the packet-loss threshold filter.
//
// The threshold T means "only show links whose worst-case loss over the visible
// range is ≥ T%". It declutters the near-full mesh without changing how any link
// is drawn: links below T are simply not loaded and not rendered.

export const DEFAULT_LOSS_THRESHOLD = 5
export const LOSS_PRESETS = [1, 3, 5, 10, 20, 30, 50, 80, 90, 100]

/**
 * Clamp/normalise a loss threshold to [0, 100] with hundredth precision.
 * Returns null when the input is not a finite number.
 * @param {unknown} value
 * @returns {number|null}
 */
export function clampLoss(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const clamped = Math.max(0, Math.min(100, n))
  return Math.round(clamped * 100) / 100
}

/** Compact display string for a threshold (trims trailing zeros). */
export function fmtLoss(value) {
  const n = clampLoss(value)
  if (n == null) return '0'
  return String(n)
}
