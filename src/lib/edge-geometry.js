// Geometry helpers for drawing links as time-coloured lines (world space).
//
// After server-side aggregation there is exactly one link per node pair, so we
// no longer bundle parallels: a straight, lightly sampled segment per link is
// both the most compact and the fastest to render at ~100-node scale.
// Self-loops become a small circle anchored at the node.

const SELF_LOOP_RADIUS = 9
const SELF_LOOP_SEGMENTS = 32

/**
 * Build a polyline (array of {x,y,u}) for a link given node world positions.
 * `u` is the normalised position 0..1 from source to target.
 */
export function edgePolyline(link, posMap, opts = {}) {
  const { sourceRadius = 6, targetRadius = 6, samples = 18 } = opts
  const s = posMap.get(link.source)
  const t = posMap.get(link.target)
  if (!s || !t) return null

  if (link.selfLoop || link.source === link.target) {
    return selfLoopPolyline(s)
  }

  const dx = t.x - s.x
  const dy = t.y - s.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len

  const sx = s.x + ux * sourceRadius
  const sy = s.y + uy * sourceRadius
  const tx = t.x - ux * targetRadius
  const ty = t.y - uy * targetRadius

  const pts = new Array(samples + 1)
  for (let i = 0; i <= samples; i += 1) {
    const u = i / samples
    pts[i] = { x: sx + (tx - sx) * u, y: sy + (ty - sy) * u, u }
  }
  return pts
}

function selfLoopPolyline(s) {
  // Concentric "health halo" hugging the node, NOT an offset floating circle:
  // a node's loopback (self-ping across its own netspaces) reads as a ring
  // around it, time-coloured by loss like any other link.
  const r = SELF_LOOP_RADIUS
  const pts = new Array(SELF_LOOP_SEGMENTS + 1)
  for (let i = 0; i <= SELF_LOOP_SEGMENTS; i += 1) {
    const u = i / SELF_LOOP_SEGMENTS
    const ang = u * Math.PI * 2 - Math.PI / 2
    pts[i] = { x: s.x + Math.cos(ang) * r, y: s.y + Math.sin(ang) * r, u }
  }
  return pts
}

/** Point on a polyline at normalised position u (0..1). */
export function pointAtU(pts, u) {
  if (!pts || pts.length === 0) return null
  const clamped = Math.max(0, Math.min(1, u))
  const idx = clamped * (pts.length - 1)
  const i0 = Math.floor(idx)
  const i1 = Math.min(pts.length - 1, i0 + 1)
  const f = idx - i0
  const a = pts[i0]
  const b = pts[i1]
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
}

/**
 * Distance from point P to a polyline, plus the closest u. Returns { dist, u }.
 */
export function distanceToPolyline(pts, px, py) {
  let best = Infinity
  let bestU = 0
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]
    const b = pts[i + 1]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const wx = px - a.x
    const wy = py - a.y
    const segLen2 = vx * vx + vy * vy || 1
    let t = (wx * vx + wy * vy) / segLen2
    t = Math.max(0, Math.min(1, t))
    const cx = a.x + vx * t
    const cy = a.y + vy * t
    const d = Math.hypot(px - cx, py - cy)
    if (d < best) {
      best = d
      bestU = (i + t) / (pts.length - 1)
    }
  }
  return { dist: best, u: bestU }
}
