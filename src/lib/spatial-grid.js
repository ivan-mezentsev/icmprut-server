// Uniform spatial grid over world-space polylines for O(1)-ish hit-testing.
//
// At production scale the graph is close to a full mesh (every node pings every
// other), so a hover/click must not linearly probe thousands of edges on every
// pointer move. We rasterise each edge's segments into the grid cells they
// cross once (when positions change), then a query only returns the handful of
// edges near the cursor cell.

/**
 * Rasterise a segment a→b into grid cells via a cheap DDA walk, visiting every
 * cell the segment passes through (no gaps).
 */
function rasterSegment(a, b, minX, minY, cell, visit) {
  const ax = (a.x - minX) / cell
  const ay = (a.y - minY) / cell
  const bx = (b.x - minX) / cell
  const by = (b.y - minY) / cell
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))))
  let px = Infinity
  let py = Infinity
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const cx = Math.floor(ax + (bx - ax) * t)
    const cy = Math.floor(ay + (by - ay) * t)
    if (cx !== px || cy !== py) {
      visit(cx, cy)
      px = cx
      py = cy
    }
  }
}

/**
 * Build a spatial grid from a Map<id, points[]> in world coordinates.
 * Returns null when the input is empty / non-finite (callers fall back to a
 * linear scan).
 *
 * @param {Map<string, Array<{x:number,y:number}>>} polylineMap
 * @returns {{ cell:number, query(x:number,y:number,radius:number): Set<string> } | null}
 */
export function buildPolylineGrid(polylineMap) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pts of polylineMap.values()) {
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX)) return null

  const span = Math.max(maxX - minX, maxY - minY, 1)
  // ~64 cells across the larger dimension keeps cell occupancy sane.
  const cell = Math.max(24, span / 64)
  const cells = new Map()
  const keyOf = (cx, cy) => `${cx}|${cy}`
  const add = (cx, cy, id) => {
    const k = keyOf(cx, cy)
    let set = cells.get(k)
    if (!set) {
      set = new Set()
      cells.set(k, set)
    }
    set.add(id)
  }

  for (const [id, pts] of polylineMap) {
    if (!pts || pts.length === 0) continue
    if (pts.length === 1) {
      const ax = Math.floor((pts[0].x - minX) / cell)
      const ay = Math.floor((pts[0].y - minY) / cell)
      add(ax, ay, id)
      continue
    }
    for (let i = 0; i < pts.length - 1; i += 1) {
      rasterSegment(pts[i], pts[i + 1], minX, minY, cell, (cx, cy) => add(cx, cy, id))
    }
  }

  return {
    cell,
    query(x, y, radius) {
      const r = Math.max(0, radius)
      const c0x = Math.floor((x - r - minX) / cell)
      const c1x = Math.floor((x + r - minX) / cell)
      const c0y = Math.floor((y - r - minY) / cell)
      const c1y = Math.floor((y + r - minY) / cell)
      const out = new Set()
      for (let cx = c0x; cx <= c1x; cx += 1) {
        for (let cy = c0y; cy <= c1y; cy += 1) {
          const set = cells.get(keyOf(cx, cy))
          if (set) for (const id of set) out.add(id)
        }
      }
      return out
    },
  }
}
