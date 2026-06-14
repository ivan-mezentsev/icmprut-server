// Loss → colour mapping for edge segments.
//
// Green (0% loss) → amber (~30%) → red (100%). A perceptually smooth ramp keeps
// the "living cloud" readable: healthy links recede, troubled links pop.

const STOPS = [
  { p: 0, rgb: [34, 197, 94] }, // emerald-500
  { p: 5, rgb: [132, 204, 22] }, // lime-500
  { p: 15, rgb: [234, 179, 8] }, // yellow-500
  { p: 35, rgb: [249, 115, 22] }, // orange-500
  { p: 70, rgb: [239, 68, 68] }, // red-500
  { p: 100, rgb: [190, 18, 60] }, // rose-700
]

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * @param {number|null|undefined} loss percentage 0..100
 * @returns {[number, number, number]}
 */
export function lossRgb(loss) {
  if (loss == null || Number.isNaN(loss)) return [120, 120, 120] // neutral no-data gray
  const p = Math.max(0, Math.min(100, loss))
  for (let i = 1; i < STOPS.length; i += 1) {
    const lo = STOPS[i - 1]
    const hi = STOPS[i]
    if (p <= hi.p) {
      const t = (p - lo.p) / (hi.p - lo.p || 1)
      return [
        Math.round(lerp(lo.rgb[0], hi.rgb[0], t)),
        Math.round(lerp(lo.rgb[1], hi.rgb[1], t)),
        Math.round(lerp(lo.rgb[2], hi.rgb[2], t)),
      ]
    }
  }
  return STOPS[STOPS.length - 1].rgb
}

export function lossCss(loss, alpha = 1) {
  const [r, g, b] = lossRgb(loss)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** No-data sentinel colour. */
export function noDataCss(alpha = 1) {
  return `rgba(120, 120, 120, ${alpha})`
}
