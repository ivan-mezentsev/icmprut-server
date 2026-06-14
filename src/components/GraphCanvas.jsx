import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useForceLayout } from '../hooks/useForceLayout.js'
import { useCamera } from '../hooks/useCamera.js'
import {
  distanceToPolyline,
  edgePolyline,
  pointAtU,
} from '../lib/edge-geometry.js'
import { lossCss, noDataCss } from '../lib/loss-color.js'

const BASE_NODE_RADIUS = 5
const HOVER_TOLERANCE_PX = 8 // screen-space hit tolerance
const CLICK_DRAG_THRESHOLD = 4
const RAIL_TINT = 'rgba(220,220,220,0.065)'

function dpr() {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

/**
 * Stable visual time orientation rule:
 * - if the link is mostly horizontal: past is left, now is right;
 * - otherwise: past is top, now is bottom.
 *
 * This makes all links readable as a tiny timeline in screen space. If the
 * natural source→target geometry points the other way, we invert bucket mapping.
 */
function shouldInvertTimeline(screen) {
  if (!screen || screen.length < 2) return false
  const a = screen[0]
  const b = screen[screen.length - 1]
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.abs(dx) >= Math.abs(dy) ? dx < 0 : dy < 0
}

/**
 * Interactive network cloud with a zoom/pan camera.
 *
 * Props:
 *  - graph: { nodes, links, range, bucketSeconds }
 *  - onEdgeHover(payload|null)
 *  - onRangeSelect({from,to})
 */
export default function GraphCanvas({ graph, activeLinkId, onEdgeHover, onEdgePin, onRangeSelect }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const layout = useForceLayout(graph, size.width, size.height)
  const camera = useCamera()

  const [hover, setHover] = useState(null)
  const [hoverNode, setHoverNode] = useState(null)
  const [brush, setBrush] = useState(null)
  const [pulseFrame, setPulseFrame] = useState(0)
  const dragRef = useRef(null) // node drag / pan / brush gesture state
  const fittedRef = useRef(false)

  const linkById = useMemo(() => {
    const m = new Map()
    if (graph) for (const l of graph.links) m.set(l.id, l)
    return m
  }, [graph])

  // Signature of the node SET (not the data) — used to decide when to re-fit
  // the camera. Live polls / range changes keep the same nodes, so the view
  // must stay put; only a genuinely different participant set re-frames.
  const nodeSig = useMemo(
    () => (graph ? graph.nodes.map((n) => n.id).sort().join(',') : ''),
    [graph],
  )

  // Adjacency: node id -> Set of neighbour node ids (for hover highlight).
  const adjacency = useMemo(() => {
    const adj = new Map()
    if (graph) {
      for (const l of graph.links) {
        if (l.source === l.target) continue
        if (!adj.has(l.source)) adj.set(l.source, new Set())
        if (!adj.has(l.target)) adj.set(l.target, new Set())
        adj.get(l.source).add(l.target)
        adj.get(l.target).add(l.source)
      }
    }
    return adj
  }, [graph])

  const hasLossyLinks = useMemo(
    () => Boolean(graph?.links?.some((l) => l.buckets?.some((b) => b.loss > 0))),
    [graph],
  )

  // Animate only when there is something lossy to pulse. Healthy graphs stay
  // fully static (no unnecessary redraw loop at production scale).
  useEffect(() => {
    if (!hasLossyLinks) return undefined
    const id = setInterval(() => {
      setPulseFrame((v) => (v + 1) & 0xffff)
    }, 160)
    return () => clearInterval(id)
  }, [hasLossyLinks])

  // Resize observer.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-fit only when the participant set changes (first load, filter change),
  // never on a routine data refresh.
  useEffect(() => {
    fittedRef.current = false
  }, [nodeSig])
  useEffect(() => {
    if (fittedRef.current) return
    if (!graph || size.width === 0) return
    if (layout.positions.size >= graph.nodes.length && graph.nodes.length > 0) {
      const id = setTimeout(() => {
        camera.fit(layout.positions, size.width, size.height)
        fittedRef.current = true
      }, 350)
      return () => clearTimeout(id)
    }
    return undefined
  }, [nodeSig, graph, size, layout.positions, layout.version, camera])

  // World polyline cache (rebuilt from positions on demand).
  const buildPolylines = useCallback(() => {
    const pos = layout.positions
    const out = new Map()
    if (!graph) return out
    for (const l of graph.links) {
      const pts = edgePolyline(l, pos, {
        sourceRadius: BASE_NODE_RADIUS + 1,
        targetRadius: BASE_NODE_RADIUS + 1,
        samples: l.selfLoop ? 28 : 16,
      })
      if (pts) out.set(l.id, pts)
    }
    return out
  }, [graph, layout.positions])

  // ---- draw loop -----------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !graph) return
    const ratio = dpr()
    const { width, height } = size
    if (width === 0 || height === 0) return
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
    }
    const ctx = canvas.getContext('2d')
    const { k } = camera.cam
    ctx.save()
    ctx.scale(ratio, ratio)
    ctx.clearRect(0, 0, width, height)

    const w2s = camera.worldToScreen
    const polylines = buildPolylines()
    const hoveredLink = hover ? linkById.get(hover.linkId) : null
    const activePinnedLink = activeLinkId ? linkById.get(activeLinkId) : null
    const activeLink = hoveredLink ?? activePinnedLink
    const frameNow = Date.now()
    const focusNode = hoverNode

    // A node or link is "focused" when hovered. Dimming only kicks in then.
    const hasFocus = Boolean(activeLink) || Boolean(focusNode)
    const neighbours = focusNode ? adjacency.get(focusNode) : null

    const linkInFocus = (l) => {
      if (activeLink) return l.id === activeLink.id
      if (focusNode) return l.source === focusNode || l.target === focusNode
      return false
    }
    const nodeInFocus = (id) => {
      if (activeLink) return activeLink.source === id || activeLink.target === id
      if (focusNode) return id === focusNode || (neighbours?.has(id) ?? false)
      return false
    }

    // Level-of-detail: hide labels & arrows when zoomed far out / very dense.
    const showLabels = k > 0.55 && graph.nodes.length <= 160
    const showRail = k > 0.4

    // links
    for (const l of graph.links) {
      const pts = polylines.get(l.id)
      if (!pts) continue
      const isFocused = linkInFocus(l)
      drawLinkRibbon(ctx, l, pts, w2s, k, {
        hovered: isFocused,
        dimmed: hasFocus && !isFocused,
        showRail,
        frameNow,
      })
    }

    if (brush) {
      const pts = polylines.get(brush.linkId)
      if (pts) drawBrush(ctx, pts, brush, w2s)
    }

    // nodes
    for (const nd of graph.nodes) {
      const p = layout.positions.get(nd.id)
      if (!p) continue
      const s = w2s(p.x, p.y)
      if (s.x < -40 || s.y < -40 || s.x > width + 40 || s.y > height + 40) continue
      const active = nodeInFocus(nd.id)
      drawNode(ctx, nd, s, k, {
        active,
        dimmed: hasFocus && !active,
        showLabel: showLabels,
      })
    }

    ctx.restore()
  }, [graph, size, layout.version, hover, hoverNode, activeLinkId, brush, pulseFrame, camera.cam, buildPolylines, linkById, adjacency, layout.positions, camera.worldToScreen])

  // ---- hit testing (screen space) -----------------------------------------
  const hitTest = useCallback(
    (sx, sy) => {
      if (!graph) return null
      const w2s = camera.worldToScreen
      // nodes first
      for (const nd of graph.nodes) {
        const p = layout.positions.get(nd.id)
        if (!p) continue
        const s = w2s(p.x, p.y)
        if (Math.hypot(s.x - sx, s.y - sy) <= BASE_NODE_RADIUS * camera.cam.k + 7) {
          return { type: 'node', id: nd.id }
        }
      }
      // links: project polyline to screen and measure
      const polylines = buildPolylines()
      let best = null
      for (const [linkId, pts] of polylines) {
        const screenPts = pts.map((pt) => {
          const s = w2s(pt.x, pt.y)
          return { x: s.x, y: s.y }
        })
        const { dist, u } = distanceToPolyline(screenPts, sx, sy)
        if (dist <= HOVER_TOLERANCE_PX && (!best || dist < best.dist)) {
          best = { type: 'link', linkId, u, dist }
        }
      }
      return best
    },
    [graph, layout.positions, buildPolylines, camera],
  )

  const toLocal = (evt) => {
    const rect = canvasRef.current.getBoundingClientRect()
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top }
  }

  // ---- wheel: zoom (ctrl/pinch or plain) / pan (shift) ---------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (evt) => {
      evt.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const sx = evt.clientX - rect.left
      const sy = evt.clientY - rect.top
      if (evt.ctrlKey || evt.metaKey) {
        // Trackpad pinch zoom.
        const factor = Math.exp(-evt.deltaY * 0.01)
        camera.zoomAt(sx, sy, factor)
      } else if (evt.shiftKey) {
        camera.panBy(-evt.deltaY, 0)
      } else {
        // Plain wheel zooms (feels natural for a map-like canvas).
        const factor = Math.exp(-evt.deltaY * 0.0015)
        camera.zoomAt(sx, sy, factor)
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [camera])

  const onPointerDown = (evt) => {
    if (!graph) return
    const { x, y } = toLocal(evt)
    canvasRef.current.setPointerCapture(evt.pointerId)
    const hit = hitTest(x, y)
    if (hit?.type === 'node') {
      const world = camera.screenToWorld(x, y)
      dragRef.current = { mode: 'node', id: hit.id }
      layout.startDrag(hit.id, world.x, world.y)
    } else if (hit?.type === 'link') {
      dragRef.current = { mode: 'maybe-brush', linkId: hit.linkId, startU: hit.u, x0: x, y0: y }
      setBrush({ linkId: hit.linkId, u0: hit.u, u1: hit.u, active: true })
    } else {
      // Panning empty space: drop any focus so nothing stays dimmed.
      setHover(null)
      setHoverNode(null)
      onEdgeHover?.(null)
      dragRef.current = { mode: 'pan', x0: x, y0: y, lastX: x, lastY: y }
    }
  }

  const onPointerMove = (evt) => {
    if (!graph) return
    const { x, y } = toLocal(evt)
    const g = dragRef.current

    if (g?.mode === 'node') {
      const world = camera.screenToWorld(x, y)
      layout.drag(g.id, world.x, world.y)
      return
    }
    if (g?.mode === 'pan') {
      camera.panBy(x - g.lastX, y - g.lastY)
      g.lastX = x
      g.lastY = y
      return
    }
    if (g?.mode === 'maybe-brush') {
      const polylines = buildPolylines()
      const pts = polylines.get(g.linkId)
      if (pts) {
        const screenPts = pts.map((pt) => camera.worldToScreen(pt.x, pt.y))
        const { u } = distanceToPolyline(screenPts, x, y)
        setBrush((b) => (b ? { ...b, u1: u } : b))
      }
      return
    }

    // hover
    const hit = hitTest(x, y)
    if (hit?.type === 'link') {
      const link = linkById.get(hit.linkId)
      const pts = buildPolylines().get(hit.linkId)
      const screenPts = pts?.map((pt) => camera.worldToScreen(pt.x, pt.y))
      const worldPt = pointAtU(pts, hit.u)
      const screenPt = worldPt ? camera.worldToScreen(worldPt.x, worldPt.y) : { x, y }
      const bucket = bucketAtVisualU(link, hit.u, screenPts)
      setHover({ linkId: hit.linkId, u: hit.u })
      setHoverNode(null)
      onEdgeHover?.({ edge: link, bucket, u: hit.u, screen: screenPt, screenPath: screenPts })
      canvasRef.current.style.cursor = 'crosshair'
    } else if (hit?.type === 'node') {
      if (hover) setHover(null)
      setHoverNode(hit.id)
      onEdgeHover?.(null)
      canvasRef.current.style.cursor = 'grab'
    } else {
      if (hover) setHover(null)
      if (hoverNode) setHoverNode(null)
      onEdgeHover?.(null)
      canvasRef.current.style.cursor = 'default'
    }
  }

  const finishBrush = useCallback(
    (g, upX, upY) => {
      const link = linkById.get(g.linkId)
      const lo = Math.min(brush?.u0 ?? g.startU, brush?.u1 ?? g.startU)
      const hi = Math.max(brush?.u0 ?? g.startU, brush?.u1 ?? g.startU)
      const moved = Math.hypot((upX ?? g.x0) - g.x0, (upY ?? g.y0) - g.y0)
      const pts = buildPolylines().get(g.linkId)
      const screenPts = pts?.map((pt) => camera.worldToScreen(pt.x, pt.y))
      if (link && hi - lo > 0.03 && moved > CLICK_DRAG_THRESHOLD) {
        const range = rangeFromVisualBrush(link, lo, hi, graph.bucketSeconds, screenPts)
        if (range) onRangeSelect?.(range)
        setBrush(null)
        return
      }
      // A click (no meaningful drag) PINS the tooltip so the cursor can enter it
      // (scroll the member list, read values) — essential near screen edges.
      if (link) {
        const worldPt = pointAtU(pts, g.startU)
        const screenPt = worldPt ? camera.worldToScreen(worldPt.x, worldPt.y) : { x: g.x0, y: g.y0 }
        const bucket = bucketAtVisualU(link, g.startU, screenPts)
        onEdgePin?.({ edge: link, bucket, u: g.startU, screen: screenPt, screenPath: screenPts })
      }
      setBrush(null)
    },
    [brush, linkById, graph, onRangeSelect, onEdgePin, buildPolylines, camera],
  )

  const onPointerUp = (evt) => {
    if (canvasRef.current?.hasPointerCapture?.(evt.pointerId)) {
      canvasRef.current.releasePointerCapture(evt.pointerId)
    }
    const { x, y } = toLocal(evt)
    const g = dragRef.current
    dragRef.current = null
    if (!g) return
    if (g.mode === 'node') {
      layout.endDrag(g.id)
    } else if (g.mode === 'maybe-brush') {
      finishBrush(g, x, y)
    } else if (g.mode === 'pan') {
      // A click on empty space dismisses a pinned tooltip.
      const moved = Math.hypot(x - g.x0, y - g.y0)
      if (moved <= CLICK_DRAG_THRESHOLD) onEdgePin?.(null)
    }
  }

  const onPointerLeave = () => {
    setHover(null)
    setHoverNode(null)
    onEdgeHover?.(null)
  }

  // expose fit/reset via double click
  const onDoubleClick = () => {
    camera.fit(layout.positions, size.width, size.height)
  }

  return (
    <div ref={wrapRef} className="graph-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        style={{ width: size.width, height: size.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
      />

      <div className="camera-controls">
        <button type="button" title="Zoom in" onClick={() => camera.zoomAt(size.width / 2, size.height / 2, 1.3)}>+</button>
        <button type="button" title="Zoom out" onClick={() => camera.zoomAt(size.width / 2, size.height / 2, 1 / 1.3)}>−</button>
        <button type="button" title="Fit to screen" onClick={() => camera.fit(layout.positions, size.width, size.height)}>⤢</button>
        <button type="button" title="Re-arrange (reheat)" onClick={() => layout.reheat()}>✦</button>
      </div>

      {graph && graph.links.length === 0 && (
        <div className="graph-empty">No links match the current range and filters.</div>
      )}
    </div>
  )
}

// ---- drawing helpers -------------------------------------------------------

function drawLinkRibbon(ctx, link, pts, w2s, k, { hovered, dimmed, showRail, frameNow }) {
  const buckets = link.buckets
  const baseAlpha = dimmed ? 0.16 : 0.92
  // Self-loop "health rings" are always a thin hairline so they read as a halo,
  // not a heavy donut around the node.
  const lineWidth = link.selfLoop
    ? (hovered ? 1.6 : 1)
    : (hovered ? 3.5 : Math.max(1, 1.6 * Math.min(1.4, k)))

  const screen = pts.map((p) => w2s(p.x, p.y))
  const invertTimeline = !link.selfLoop && shouldInvertTimeline(screen)

  if (showRail) {
    ctx.lineWidth = lineWidth + 2
    ctx.strokeStyle = RAIL_TINT
    ctx.beginPath()
    ctx.moveTo(screen[0].x, screen[0].y)
    for (let i = 1; i < screen.length; i += 1) ctx.lineTo(screen[i].x, screen[i].y)
    ctx.stroke()
  }

  if (!buckets || buckets.length === 0) {
    ctx.lineWidth = lineWidth
    ctx.strokeStyle = noDataCss(baseAlpha * 0.6)
    ctx.beginPath()
    ctx.moveTo(screen[0].x, screen[0].y)
    for (let i = 1; i < screen.length; i += 1) ctx.lineTo(screen[i].x, screen[i].y)
    ctx.stroke()
    return
  }

  // ---------------------------------------------------------------------------
  // Loss colouring is driven by BUCKETS, never by the geometry sample count.
  // Each bucket i owns the line span u∈[i/n,(i+1)/n] and is drawn as its own
  // sub-segment, so a single lossy bucket among hundreds can NEVER be skipped
  // (the old code sampled the bucket array at a few fixed u's and dropped most
  // of them — the source of the flickering loss). The polyline is walked
  // continuously so segments follow any curvature (self-loop rings included).
  // ---------------------------------------------------------------------------
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  const n = buckets.length
  const lastPt = pts.length - 1
  // Interpolate a screen point at fractional polyline index (u in [0,1]).
  const at = (u) => {
    const f = Math.max(0, Math.min(lastPt, u * lastPt))
    const i0 = Math.floor(f)
    const i1 = Math.min(lastPt, i0 + 1)
    const t = f - i0
    const a = screen[i0]
    const b = screen[i1]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  for (let i = 0; i < n; i += 1) {
    const visualIndex = invertTimeline ? n - 1 - i : i
    const u0 = visualIndex / n
    const u1 = (visualIndex + 1) / n
    const alpha = bucketAlpha(i, n, buckets[i]?.loss, baseAlpha, frameNow)
    ctx.strokeStyle = lossCss(buckets[i]?.loss, alpha)
    ctx.beginPath()
    const sa = at(u0)
    ctx.moveTo(sa.x, sa.y)
    // Include any geometry vertices strictly inside (u0,u1) so curved paths
    // (self-loop rings) stay smooth instead of chording across the arc.
    const lo = Math.ceil(u0 * lastPt + 1e-6)
    const hi = Math.floor(u1 * lastPt - 1e-6)
    for (let j = lo; j <= hi; j += 1) {
      const s = screen[j]
      ctx.lineTo(s.x, s.y)
    }
    const sb = at(u1)
    ctx.lineTo(sb.x, sb.y)
    ctx.stroke()
  }

  // Second pass: emphasise lossy buckets so a single bad minute inside a long
  // window is never invisible. We guarantee a minimum on-screen length and a
  // thicker stroke; deterministic because it is keyed on the bucket index.
  const totalLenPx = polylineScreenLength(screen)
  const minLenPx = 6
  let drewLossy = false
  for (let i = 0; i < n; i += 1) {
    const loss = buckets[i]?.loss
    if (loss == null || loss <= 0) continue
    drewLossy = true
    const visualIndex = invertTimeline ? n - 1 - i : i
    const mid = (visualIndex + 0.5) / n
    // Expand the highlight to at least minLenPx around the bucket centre.
    const halfU = Math.max((1 / n) / 2, totalLenPx > 0 ? minLenPx / 2 / totalLenPx : 0.01)
    const u0 = Math.max(0, mid - halfU)
    const u1 = Math.min(1, mid + halfU)
    const sa = at(u0)
    const sb = at(u1)
    ctx.lineWidth = lineWidth + 2.5
    ctx.lineCap = 'round'
    ctx.strokeStyle = lossCss(loss, bucketAlpha(i, n, loss, dimmed ? 0.55 : 1, frameNow))
    ctx.beginPath()
    ctx.moveTo(sa.x, sa.y)
    ctx.lineTo(sb.x, sb.y)
    ctx.stroke()
  }
  if (drewLossy) {
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'butt'
  }

  drawNowMarker(ctx, screen, invertTimeline, hovered, dimmed)
}

function polylineScreenLength(screen) {
  let len = 0
  for (let i = 1; i < screen.length; i += 1) {
    len += Math.hypot(screen[i].x - screen[i - 1].x, screen[i].y - screen[i - 1].y)
  }
  return len
}

function bucketAlpha(index, total, loss, baseAlpha, frameNow) {
  if (loss == null || loss <= 0) return baseAlpha
  // 0 = oldest, 1 = newest. Recent losses glow; older losses remain visible but
  // subdued, answering "was it just now or long ago?" without adding labels.
  const recency = total <= 1 ? 1 : index / (total - 1)
  const base = 0.38 + 0.62 * recency
  const pulseBand = recency > 0.82 ? (recency - 0.82) / 0.18 : 0
  const pulse = pulseBand * (0.12 + 0.1 * Math.sin(frameNow / 260))
  return clamp01(baseAlpha * (base + pulse))
}

function drawNowMarker(ctx, screen, invertTimeline, hovered, dimmed) {
  if (!screen || screen.length < 2) return
  const end = invertTimeline ? screen[0] : screen[screen.length - 1]
  const prev = invertTimeline ? screen[1] : screen[screen.length - 2]
  const ang = Math.atan2(end.y - prev.y, end.x - prev.x)
  const alpha = dimmed ? 0.25 : hovered ? 0.95 : 0.55
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(end.x, end.y)
  ctx.rotate(ang)
  ctx.fillStyle = '#e5e5e5'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.lineWidth = 1
  // Small "now" tick/arrow at the current-time end of the timeline.
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-5, -3)
  ctx.lineTo(-5, 3)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.restore()
}

function drawBrush(ctx, pts, brush, w2s) {
  const lo = Math.min(brush.u0, brush.u1)
  const hi = Math.max(brush.u0, brush.u1)
  ctx.save()
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(235, 235, 235, 0.55)'
  ctx.beginPath()
  let started = false
  for (let i = 0; i < pts.length; i += 1) {
    if (pts[i].u >= lo && pts[i].u <= hi) {
      const s = w2s(pts[i].x, pts[i].y)
      if (!started) {
        ctx.moveTo(s.x, s.y)
        started = true
      } else {
        ctx.lineTo(s.x, s.y)
      }
    }
  }
  ctx.stroke()
  ctx.restore()
}

function drawNode(ctx, node, s, k, { active, dimmed, showLabel }) {
  const r = (BASE_NODE_RADIUS + Math.min(4, Math.log2(1 + node.degree))) * Math.min(1.3, Math.max(0.7, k))
  const alpha = dimmed ? 0.28 : 1
  ctx.save()
  ctx.globalAlpha = alpha

  ctx.beginPath()
  ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2)
  ctx.fillStyle = active ? 'rgba(255, 255, 255, 0.18)' : 'rgba(180, 180, 180, 0.045)'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2)
  ctx.fillStyle = active ? '#ffffff' : '#d8d8d8'
  ctx.fill()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.stroke()

  if (showLabel) {
    ctx.font = `600 ${Math.round(11 * Math.min(1.2, Math.max(0.85, k)))}px Inter, system-ui, sans-serif`
    ctx.fillStyle = active ? '#ffffff' : 'rgba(215, 215, 215, 0.76)'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(node.id, s.x, s.y + r + 2)
  }
  ctx.restore()
}

// ---- bucket/range helpers --------------------------------------------------

function dataUFromVisualU(link, visualU, screenPts) {
  const invert = !link?.selfLoop && shouldInvertTimeline(screenPts)
  return invert ? 1 - visualU : visualU
}

function bucketAtVisualU(link, visualU, screenPts) {
  if (!link?.buckets?.length) return null
  const n = link.buckets.length
  const dataU = dataUFromVisualU(link, visualU, screenPts)
  const i = Math.min(n - 1, Math.max(0, Math.floor(dataU * n)))
  return link.buckets[i]
}

function rangeFromVisualBrush(link, visualLo, visualHi, bucketSeconds, screenPts) {
  if (!link?.buckets?.length) return null
  const n = link.buckets.length
  const dataA = dataUFromVisualU(link, visualLo, screenPts)
  const dataB = dataUFromVisualU(link, visualHi, screenPts)
  const lo = Math.min(dataA, dataB)
  const hi = Math.max(dataA, dataB)
  const i0 = Math.min(n - 1, Math.max(0, Math.floor(lo * n)))
  const i1 = Math.min(n - 1, Math.max(0, Math.floor(hi * n)))
  const stepMs = (bucketSeconds ?? 60) * 1000
  return { from: link.buckets[i0].t, to: link.buckets[i1].t + stepMs }
}
