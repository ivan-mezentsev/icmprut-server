import { useCallback, useRef, useState } from 'react'

// World↔screen camera: screen = (world - {x,y}) * k.  `k` is zoom scale.
// Trackpad pinch (ctrl+wheel) and wheel both zoom toward the cursor; two-finger
// scroll / drag on empty space pans. Auto-fit frames all node positions.

const MIN_K = 0.15
const MAX_K = 6

export function useCamera() {
  const [cam, setCam] = useState({ x: 0, y: 0, k: 1 })
  const camRef = useRef(cam)
  camRef.current = cam

  const worldToScreen = useCallback((wx, wy) => {
    const c = camRef.current
    return { x: (wx - c.x) * c.k, y: (wy - c.y) * c.k }
  }, [])

  const screenToWorld = useCallback((sx, sy) => {
    const c = camRef.current
    return { x: sx / c.k + c.x, y: sy / c.k + c.y }
  }, [])

  // Zoom by `factor` keeping the world point under (sx,sy) fixed on screen.
  const zoomAt = useCallback((sx, sy, factor) => {
    setCam((c) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, c.k * factor))
      if (k === c.k) return c
      // world point currently under cursor
      const wx = sx / c.k + c.x
      const wy = sy / c.k + c.y
      // keep it fixed: sx = (wx - x') * k  =>  x' = wx - sx/k
      return { x: wx - sx / k, y: wy - sy / k, k }
    })
  }, [])

  const panBy = useCallback((dxScreen, dyScreen) => {
    setCam((c) => ({ ...c, x: c.x - dxScreen / c.k, y: c.y - dyScreen / c.k }))
  }, [])

  // Fit all positions into the viewport with padding.
  const fit = useCallback((positions, width, height, padding = 80) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let count = 0
    for (const p of positions.values()) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
      count += 1
    }
    if (count === 0 || !width || !height) return
    const w = Math.max(1, maxX - minX)
    const h = Math.max(1, maxY - minY)
    const k = Math.max(
      MIN_K,
      Math.min(MAX_K, Math.min((width - padding * 2) / w, (height - padding * 2) / h)),
    )
    const cxWorld = (minX + maxX) / 2
    const cyWorld = (minY + maxY) / 2
    setCam({ x: cxWorld - width / 2 / k, y: cyWorld - height / 2 / k, k })
  }, [])

  const reset = useCallback(() => setCam({ x: 0, y: 0, k: 1 }), [])

  return { cam, worldToScreen, screenToWorld, zoomAt, panBy, fit, reset }
}
