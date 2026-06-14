import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useForceLayout } from '../hooks/useForceLayout.js'
import { useCamera } from '../hooks/useCamera.js'
import {
  distanceToPolyline,
  edgePolyline,
  pointAtU,
} from '../lib/edge-geometry.js'
import { buildPolylineGrid } from '../lib/spatial-grid.js'
import { lossCss, noDataCss } from '../lib/loss-color.js'

const BASE_NODE_RADIUS = 5
const HOVER_TOLERANCE_PX = 8 // screen-space hit tolerance
const CLICK_DRAG_THRESHOLD = 4
const RAIL_TINT = 'rgba(220,220,220,0.065)'
// Above this link count the canvas switches to a cheap single-segment renderer
// for non-focused links (one stroke per link instead of one per time bucket).
const LOD_LINK_THRESHOLD = 600

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
export default function GraphCanvas({
  graph,
  activeLinkId,
  selectedHost = null,
  onHostSelect,
  onEdgeHover,
  onEdgePin,
  onRangeSelect,
}) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const layout = useForceLayout(graph, size.width, size.height)
  const camera = useCamera()
  // Stable camera accessors (memoised in useCamera); only `cam` changes on
  // pan/zoom. Reading these instead of the whole `camera` object keeps the
  // imperative draw loop's identity stable across renders.
  const { cam, camRef, worldToScreen, screenToWorld, zoomAt, panBy, fit } = camera

  // ---- view state lives in REFS (no React re-render on hover/brush/pan) ----
  // The hot pointer path never calls setState; it mutates these refs and asks
  // for a single coalesced redraw, so dragging/hovering a near-full mesh no
  // longer re-renders React thousands of times.
  const hoverRef = useRef(null) // { linkId, u } | null
  const hoverNodeRef = useRef(null) // node id | null
  const brushRef = useRef(null) // { linkId, u0, u1 } | null
  const dragRef = useRef(null) // node drag / pan / brush gesture state
  const fittedRef = useRef(false)
  const rafRef = useRef(0)
  const graphRef = useRef(graph)
  const sizeRef = useRef(size)
  const activeLinkIdRef = useRef(activeLinkId)
  const activeHostRef = useRef(selectedHost)
  const frameNowRef = useRef(Date.now())
  // World-space polyline + spatial-grid cache, invalidated by sim version.
  const polyCacheRef = useRef({ version: -1, map: new Map(), grid: null })
  graphRef.current = graph
  sizeRef.current = size
  activeLinkIdRef.current = activeLinkId
  activeHostRef.current = selectedHost

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
  // The pulse only matters where per-bucket ribbons are actually drawn. In
  // dense (LOD) graphs non-focused links are single segments, so a global pulse
  // would repaint thousands of links 6×/s for nothing. Restrict it to small,
  // lossy graphs — OR when a host is pinned (only its handful of links render
  // as full ribbons, so animating their glow is cheap and aids investigation).
  const pulseEnabled =
    hasLossyLinks &&
    ((graph?.links?.length ?? 0) <= LOD_LINK_THRESHOLD || Boolean(selectedHost))

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

  // World polyline + spatial-grid cache. Rebuilt ONLY when the simulation tick
  // version changes (positions actually moved); idle pan / zoom / hover reuse
  // it. This is what stops a near-full mesh from reprojecting thousands of
  // edges on every pointer move.
  const getPolylines = useCallback(() => {
    const cache = polyCacheRef.current
    const version = layout.getVersion()
    if (cache.version === version && cache.map.size > 0) return cache
    const pos = layout.positions
    const map = new Map()
    const g = graphRef.current
    if (g) {
      for (const l of g.links) {
        const pts = edgePolyline(l, pos, {
          sourceRadius: BASE_NODE_RADIUS + 1,
          targetRadius: BASE_NODE_RADIUS + 1,
          // Straight links need only their two endpoints: per-bucket colouring
          // interpolates along the segment, so extra samples were pure waste
          // (16× the transform/draw work for thousands of edges). Self-loops
          // keep enough samples to read as a smooth ring.
          samples: l.selfLoop ? 28 : 1,
        })
        if (pts) map.set(l.id, pts)
      }
    }
    cache.version = version
    cache.map = map
    cache.grid = buildPolylineGrid(map)
    return cache
  }, [layout])

  // ---- single coalesced redraw on the next animation frame -----------------
  const drawNow = useCallback(() => {
    const canvas = canvasRef.current
    const g = graphRef.current
    if (!canvas || !g) return
    const ratio = dpr()
    const { width, height } = sizeRef.current
    if (width === 0 || height === 0) return
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
    }
    const ctx = canvas.getContext('2d')
    const cam = camRef.current
    const k = cam.k
    const w2s = (wx, wy) => ({ x: (wx - cam.x) * k, y: (wy - cam.y) * k })
    ctx.save()
    ctx.scale(ratio, ratio)
    ctx.clearRect(0, 0, width, height)

    const { map: polylines } = getPolylines()
    const hover = hoverRef.current
    const hoverNode = hoverNodeRef.current
    const brush = brushRef.current
    const hoveredLink = hover ? linkById.get(hover.linkId) : null
    const activePinnedLink = activeLinkIdRef.current
      ? linkById.get(activeLinkIdRef.current)
      : null
    const activeLink = hoveredLink ?? activePinnedLink
    const frameNow = Date.now()
    frameNowRef.current = frameNow
    const focusNode = hoverNode

    // A pinned host is a PERSISTENT focus: only valid if it still exists in the
    // current data. Its links are always shown in full per-bucket detail (no
    // LOD), its neighbourhood stays lit and the rest of the cloud dims so the
    // host can be investigated end-to-end.
    const selHost =
      activeHostRef.current && layout.positions.has(activeHostRef.current)
        ? activeHostRef.current
        : null
    const hostNeighbours = selHost ? adjacency.get(selHost) : null
    const isHostLink = (l) => selHost != null && (l.source === selHost || l.target === selHost)

    // A node or link is "focused" when hovered, OR when it belongs to the
    // pinned host. Dimming kicks in whenever any focus is active.
    const hasFocus = Boolean(selHost) || Boolean(activeLink) || Boolean(focusNode)
    const neighbours = focusNode ? adjacency.get(focusNode) : null

    const linkInFocus = (l) => {
      // With a pinned host, "focus" = the host's links (the hovered one of them
      // is emphasised further below); never another node's links.
      if (selHost) return isHostLink(l)
      if (activeLink) return l.id === activeLink.id
      if (focusNode) return l.source === focusNode || l.target === focusNode
      return false
    }
    const nodeInFocus = (id) => {
      if (selHost) return id === selHost || (hostNeighbours?.has(id) ?? false)
      if (activeLink) return activeLink.source === id || activeLink.target === id
      if (focusNode) return id === focusNode || (neighbours?.has(id) ?? false)
      return false
    }

    // Level-of-detail: hide labels & arrows when zoomed far out / very dense.
    const showLabels = k > 0.55 && g.nodes.length <= 160
    const showRail = k > 0.4
    // Dense mode: a near-full mesh has thousands of links. Painting every link
    // as a full per-bucket ribbon is the real cost (60 buckets × 3000 links =
    // ~180k strokes/frame). In dense mode every NON-focused link is a single
    // segment tinted by its worst-case loss; the full timeline ribbon is drawn
    // only for the focused/pinned link (where the user actually reads it).
    const dense = g.links.length > LOD_LINK_THRESHOLD

    // links
    for (const l of g.links) {
      const pts = polylines.get(l.id)
      if (!pts) continue
      // With a host pinned, hide every link that is not its own — dimming was
      // not enough; foreign links must be out of the way during investigation.
      if (selHost && !isHostLink(l)) continue
      const isFocused = linkInFocus(l)
      if (dense && !isFocused) {
        drawLinkSimple(ctx, l, pts, w2s, k, { dimmed: hasFocus })
      } else {
        // When a host is pinned, the single hovered/clicked link is the only
        // one drawn as "hovered" (thicker); the host's other links are full
        // ribbons but not emphasised.
        const emphasised = selHost
          ? Boolean(activeLink) && l.id === activeLink.id
          : isFocused
        drawLinkRibbon(ctx, l, pts, w2s, k, {
          hovered: emphasised,
          dimmed: hasFocus && !isFocused,
          showRail,
          frameNow,
        })
      }
    }

    if (brush) {
      const pts = polylines.get(brush.linkId)
      if (pts) drawBrush(ctx, pts, brush, w2s)
    }

    // nodes
    const pos = layout.positions
    for (const nd of g.nodes) {
      const p = pos.get(nd.id)
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
  }, [getPolylines, linkById, adjacency, layout, camRef])

  // Schedule at most one redraw per animation frame.
  const requestDraw = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      drawNow()
    })
  }, [drawNow])

  // Drive redraws from simulation ticks (coalesced) + a settle pass.
  useEffect(() => {
    const offTick = layout.onTick(requestDraw)
    const offSettle = layout.onSettle(requestDraw)
    requestDraw()
    return () => {
      offTick()
      offSettle()
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [layout, requestDraw])

  // Redraw when React-level inputs change (data, size, camera, pinned link).
  useEffect(() => {
    requestDraw()
  }, [graph, size, cam, activeLinkId, selectedHost, requestDraw])

  // Pulse only when something lossy is drawn as a ribbon: a low-rate redraw
  // clock that re-evaluates the glow phase. Healthy or dense graphs never
  // schedule it.
  useEffect(() => {
    if (!pulseEnabled) return undefined
    const id = setInterval(requestDraw, 160)
    return () => clearInterval(id)
  }, [pulseEnabled, requestDraw])

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
        fit(layout.positions, size.width, size.height)
        fittedRef.current = true
        requestDraw()
      }, 350)
      return () => clearTimeout(id)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeSig, graph, size, layout, fit, requestDraw])

  // ---- hit testing (screen space) -----------------------------------------
  const hitTest = useCallback(
    (sx, sy) => {
      const g = graphRef.current
      if (!g) return null
      const cam = camRef.current
      const k = cam.k
      const w2s = (wx, wy) => ({ x: (wx - cam.x) * k, y: (wy - cam.y) * k })
      // nodes first
      for (const nd of g.nodes) {
        const p = layout.positions.get(nd.id)
        if (!p) continue
        const s = w2s(p.x, p.y)
        if (Math.hypot(s.x - sx, s.y - sy) <= BASE_NODE_RADIUS * k + 7) {
          return { type: 'node', id: nd.id }
        }
      }
      // links: query only edges whose world cells are near the cursor, then
      // project just those few polylines to screen and measure.
      const { map: polylines, grid } = getPolylines()
      const world = { x: sx / k + cam.x, y: sy / k + cam.y }
      const worldTol = HOVER_TOLERANCE_PX / k
      const candidates = grid ? grid.query(world.x, world.y, worldTol) : polylines.keys()
      // With a host pinned, the cursor may only investigate THAT host's links;
      // foreign connections are not hoverable/clickable.
      const selHost =
        activeHostRef.current && layout.positions.has(activeHostRef.current)
          ? activeHostRef.current
          : null
      let best = null
      for (const linkId of candidates) {
        const pts = polylines.get(linkId)
        if (!pts) continue
        if (selHost) {
          const l = linkById.get(linkId)
          if (!l || (l.source !== selHost && l.target !== selHost)) continue
        }
        const screenPts = pts.map((pt) => w2s(pt.x, pt.y))
        const { dist, u } = distanceToPolyline(screenPts, sx, sy)
        if (dist <= HOVER_TOLERANCE_PX && (!best || dist < best.dist)) {
          best = { type: 'link', linkId, u, dist }
        }
      }
      return best
    },
    [layout, getPolylines, camRef, linkById],
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
        zoomAt(sx, sy, factor)
      } else if (evt.shiftKey) {
        panBy(-evt.deltaY, 0)
      } else {
        // Plain wheel zooms (feels natural for a map-like canvas).
        const factor = Math.exp(-evt.deltaY * 0.0015)
        zoomAt(sx, sy, factor)
      }
      requestDraw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [zoomAt, panBy, requestDraw])

  const onPointerDown = (evt) => {
    if (!graph) return
    const { x, y } = toLocal(evt)
    canvasRef.current.setPointerCapture(evt.pointerId)
    const hit = hitTest(x, y)
    if (hit?.type === 'node') {
      const world = screenToWorld(x, y)
      dragRef.current = { mode: 'node', id: hit.id, x0: x, y0: y }
      layout.startDrag(hit.id, world.x, world.y)
    } else if (hit?.type === 'link') {
      dragRef.current = { mode: 'maybe-brush', linkId: hit.linkId, startU: hit.u, x0: x, y0: y }
      brushRef.current = { linkId: hit.linkId, u0: hit.u, u1: hit.u, active: true }
      requestDraw()
    } else {
      // Panning empty space: drop any focus so nothing stays dimmed.
      hoverRef.current = null
      hoverNodeRef.current = null
      onEdgeHover?.(null)
      dragRef.current = { mode: 'pan', x0: x, y0: y, lastX: x, lastY: y }
      requestDraw()
    }
  }

  const onPointerMove = (evt) => {
    if (!graph) return
    const { x, y } = toLocal(evt)
    const g = dragRef.current

    if (g?.mode === 'node') {
      const world = screenToWorld(x, y)
      layout.drag(g.id, world.x, world.y)
      return
    }
    if (g?.mode === 'pan') {
      panBy(x - g.lastX, y - g.lastY)
      g.lastX = x
      g.lastY = y
      requestDraw()
      return
    }
    if (g?.mode === 'maybe-brush') {
      const { map: polylines } = getPolylines()
      const pts = polylines.get(g.linkId)
      if (pts) {
        const screenPts = pts.map((pt) => worldToScreen(pt.x, pt.y))
        const { u } = distanceToPolyline(screenPts, x, y)
        if (brushRef.current) {
          brushRef.current = { ...brushRef.current, u1: u }
          requestDraw()
        }
      }
      return
    }

    // hover
    const hit = hitTest(x, y)
    if (hit?.type === 'link') {
      const link = linkById.get(hit.linkId)
      const pts = getPolylines().map.get(hit.linkId)
      const screenPts = pts?.map((pt) => worldToScreen(pt.x, pt.y))
      const worldPt = pointAtU(pts, hit.u)
      const screenPt = worldPt ? worldToScreen(worldPt.x, worldPt.y) : { x, y }
      const bucket = bucketAtVisualU(link, hit.u, screenPts)
      hoverRef.current = { linkId: hit.linkId, u: hit.u }
      hoverNodeRef.current = null
      onEdgeHover?.({ edge: link, bucket, u: hit.u, screen: screenPt, screenPath: screenPts })
      canvasRef.current.style.cursor = 'crosshair'
      requestDraw()
    } else if (hit?.type === 'node') {
      hoverRef.current = null
      hoverNodeRef.current = hit.id
      onEdgeHover?.(null)
      canvasRef.current.style.cursor = 'grab'
      requestDraw()
    } else {
      const changed = hoverRef.current || hoverNodeRef.current
      hoverRef.current = null
      hoverNodeRef.current = null
      onEdgeHover?.(null)
      canvasRef.current.style.cursor = 'default'
      if (changed) requestDraw()
    }
  }

  const finishBrush = useCallback(
    (g, upX, upY) => {
      const link = linkById.get(g.linkId)
      const brush = brushRef.current
      const lo = Math.min(brush?.u0 ?? g.startU, brush?.u1 ?? g.startU)
      const hi = Math.max(brush?.u0 ?? g.startU, brush?.u1 ?? g.startU)
      const moved = Math.hypot((upX ?? g.x0) - g.x0, (upY ?? g.y0) - g.y0)
      const pts = getPolylines().map.get(g.linkId)
      const screenPts = pts?.map((pt) => worldToScreen(pt.x, pt.y))
      if (link && hi - lo > 0.03 && moved > CLICK_DRAG_THRESHOLD) {
        const range = rangeFromVisualBrush(link, lo, hi, graphRef.current?.bucketSeconds, screenPts)
        if (range) onRangeSelect?.(range)
        brushRef.current = null
        requestDraw()
        return
      }
      // A click (no meaningful drag) PINS the tooltip so the cursor can enter it
      // (scroll the member list, read values) — essential near screen edges.
      if (link) {
        const worldPt = pointAtU(pts, g.startU)
        const screenPt = worldPt ? worldToScreen(worldPt.x, worldPt.y) : { x: g.x0, y: g.y0 }
        const bucket = bucketAtVisualU(link, g.startU, screenPts)
        onEdgePin?.({ edge: link, bucket, u: g.startU, screen: screenPt, screenPath: screenPts })
      }
      brushRef.current = null
      requestDraw()
    },
    [linkById, onRangeSelect, onEdgePin, getPolylines, worldToScreen, requestDraw],
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
      // A click on a node (no meaningful drag) pins/switches the host selection.
      const moved = Math.hypot(x - g.x0, y - g.y0)
      if (moved <= CLICK_DRAG_THRESHOLD) {
        onHostSelect?.(g.id)
        onEdgePin?.(null)
        hoverRef.current = null
        onEdgeHover?.(null)
        requestDraw()
      }
    } else if (g.mode === 'maybe-brush') {
      finishBrush(g, x, y)
    } else if (g.mode === 'pan') {
      // A click on empty space clears the pinned host + tooltip.
      const moved = Math.hypot(x - g.x0, y - g.y0)
      if (moved <= CLICK_DRAG_THRESHOLD) {
        onEdgePin?.(null)
        if (activeHostRef.current) {
          onHostSelect?.(null)
          requestDraw()
        }
      }
    }
  }

  const onPointerLeave = () => {
    const changed = hoverRef.current || hoverNodeRef.current
    hoverRef.current = null
    hoverNodeRef.current = null
    onEdgeHover?.(null)
    if (changed) requestDraw()
  }

  // expose fit/reset via double click
  const onDoubleClick = () => {
    fit(layout.positions, size.width, size.height)
    requestDraw()
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
        <button type="button" title="Zoom in" onClick={() => { zoomAt(size.width / 2, size.height / 2, 1.3); requestDraw() }}>+</button>
        <button type="button" title="Zoom out" onClick={() => { zoomAt(size.width / 2, size.height / 2, 1 / 1.3); requestDraw() }}>−</button>
        <button type="button" title="Fit to screen" onClick={() => { fit(layout.positions, size.width, size.height); requestDraw() }}>⤢</button>
        <button type="button" title="Re-arrange (reheat)" onClick={() => layout.reheat()}>✦</button>
      </div>

      {graph && graph.links.length === 0 && (
        <div className="graph-empty">No links match the current range and filters.</div>
      )}
    </div>
  )
}

// ---- drawing helpers -------------------------------------------------------

/**
 * Cheap single-segment link for dense graphs: ONE stroke tinted by the link's
 * worst-case loss (or a no-data hairline). No per-bucket loop, no rail, no now
 * marker — this is what keeps a near-full mesh at interactive frame rates. The
 * full per-bucket timeline is still drawn for the focused/pinned link.
 */
function drawLinkSimple(ctx, link, pts, w2s, k, { dimmed }) {
  if (!pts || pts.length === 0) return
  const worst = link.summary?.lossMax ?? link.summary?.lossAvg ?? null
  const baseAlpha = dimmed ? 0.1 : 0.7
  ctx.lineWidth = link.selfLoop ? 1 : Math.max(0.8, 1.2 * Math.min(1.2, k))
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = worst == null ? noDataCss(baseAlpha * 0.7) : lossCss(worst, baseAlpha)
  ctx.beginPath()
  const a = w2s(pts[0].x, pts[0].y)
  ctx.moveTo(a.x, a.y)
  for (let i = 1; i < pts.length; i += 1) {
    const s = w2s(pts[i].x, pts[i].y)
    ctx.lineTo(s.x, s.y)
  }
  ctx.stroke()
}

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
