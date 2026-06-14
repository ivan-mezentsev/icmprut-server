// Dense, production-oriented hover/pinned tooltip for an aggregated link.
//
// Design goals (vs. the previous airy card):
//   - minimal padding / line-height; every label is low and tight
//   - metrics laid out in compact two-column grids (no tall stacks)
//   - the full member list is scrollable (no "+N more"): readable with dozens
//     of lossy connections
//   - PINNED mode: when the user clicks a link the tooltip becomes interactive
//     (pointer events on, cursor can enter it to scroll), with a close button
//   - clamped to the viewport using the REAL measured size, so links near the
//     bottom/right edge never push content off-screen

import { useLayoutEffect, useRef, useState } from 'react'
import { fmtAbsolute } from '../lib/time.js'
import { lossCss } from '../lib/loss-color.js'

function num(value, digits = 2, suffix = '') {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}${suffix}`
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x)
}

function segmentsIntersect(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)
}

function segmentIntersectsRect(a, b, rect) {
  if (
    (a.x >= rect.left && a.x <= rect.right && a.y >= rect.top && a.y <= rect.bottom) ||
    (b.x >= rect.left && b.x <= rect.right && b.y >= rect.top && b.y <= rect.bottom)
  ) {
    return true
  }
  const tl = { x: rect.left, y: rect.top }
  const tr = { x: rect.right, y: rect.top }
  const br = { x: rect.right, y: rect.bottom }
  const bl = { x: rect.left, y: rect.bottom }
  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  )
}

function rectDistanceToSegment(rect, a, b) {
  if (segmentIntersectsRect(a, b, rect)) return 0
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ]
  let best = Infinity
  for (const c of corners) best = Math.min(best, distPointToSegment(c.x, c.y, a.x, a.y, b.x, b.y))
  const edges = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ]
  for (const [ea, eb] of edges) {
    best = Math.min(best, distPointToSegment(a.x, a.y, ea.x, ea.y, eb.x, eb.y))
    best = Math.min(best, distPointToSegment(b.x, b.y, ea.x, ea.y, eb.x, eb.y))
  }
  return best
}

function rectDistanceToPath(rect, path) {
  if (!path || path.length < 2) return Infinity
  let best = Infinity
  for (let i = 1; i < path.length; i += 1) {
    best = Math.min(best, rectDistanceToSegment(rect, path[i - 1], path[i]))
    if (best === 0) return 0
  }
  return best
}

function pointDistanceToRect(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
  return Math.hypot(dx, dy)
}

function chooseSafeTooltipPosition({ anchor, path, width, height, container, gap, preferredSide }) {
  const margin = 8
  const maxLeft = Math.max(margin, container.width - width - margin)
  const maxTop = Math.max(margin, container.height - height - margin)
  const side = Math.max(gap, 22)
  const farSide = side + 22
  const raw = [
    { side: 'right', left: anchor.x + side, top: anchor.y - height / 2 },
    { side: 'left', left: anchor.x - width - side, top: anchor.y - height / 2 },
    { side: 'bottom', left: anchor.x - width / 2, top: anchor.y + side },
    { side: 'top', left: anchor.x - width / 2, top: anchor.y - height - side },
    { side: 'right', left: anchor.x + side, top: anchor.y + side },
    { side: 'right', left: anchor.x + side, top: anchor.y - height - side },
    { side: 'left', left: anchor.x - width - side, top: anchor.y + side },
    { side: 'left', left: anchor.x - width - side, top: anchor.y - height - side },
    { side: 'right', left: anchor.x + farSide, top: anchor.y - height / 2 },
    { side: 'left', left: anchor.x - width - farSide, top: anchor.y - height / 2 },
  ]

  const candidates = raw.map((c) => {
    const left = clamp(c.left, margin, maxLeft)
    const top = clamp(c.top, margin, maxTop)
    const rect = { left, top, right: left + width, bottom: top + height }
    const pathDistance = rectDistanceToPath(rect, path)
    const anchorDistance = pointDistanceToRect(anchor, rect)
    const centerDistance = Math.hypot(left + width / 2 - anchor.x, top + height / 2 - anchor.y)
    // Keep the tooltip local. Prefer nearby candidates, but reject positions
    // that intersect or hug the investigated link path.
    const unsafePenalty = pathDistance < 18 ? 1_000_000 : 0
    const cursorPenalty = anchorDistance < 18 ? 1_000_000 : 0
    const score = -centerDistance - unsafePenalty - cursorPenalty + Math.min(pathDistance, 40) * 8
    return { side: c.side, left, top, pathDistance, anchorDistance, score }
  })

  if (preferredSide) {
    const sticky = candidates
      .filter((c) => c.side === preferredSide && c.anchorDistance >= 18 && c.pathDistance >= 8)
      .sort((a, b) => b.score - a.score)[0]
    if (sticky) return sticky
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0]
  return best ?? { left: margin, top: margin }
}

export default function EdgeTooltip({ payload, pinned = false, containerSize, onClose }) {
  const ref = useRef(null)
  const placementRef = useRef({ edgeId: null, side: null })
  const [pos, setPos] = useState({ left: 0, top: 0, ready: false })

  const screen = payload?.screen
  const anchorX = screen?.x ?? 0
  const anchorY = screen?.y ?? 0
  const screenPath = payload?.screenPath ?? []

  // Clamp using the actually rendered size (measured), so nothing overflows.
  useLayoutEffect(() => {
    if (!payload || !ref.current || !containerSize) return
    const rect = ref.current.getBoundingClientRect()
    const gap = pinned ? 18 : 28
    const w = rect.width
    const h = rect.height
    const edgeId = payload.edge?.id ?? null
    const preferredSide = placementRef.current.edgeId === edgeId ? placementRef.current.side : null
    const next = chooseSafeTooltipPosition({
      anchor: { x: anchorX, y: anchorY },
      path: screenPath,
      width: w,
      height: h,
      container: containerSize,
      gap,
      preferredSide,
    })
    placementRef.current = { edgeId, side: next.side ?? preferredSide }
    setPos({ left: next.left, top: next.top, ready: true })
  }, [payload, pinned, anchorX, anchorY, containerSize, screenPath])

  if (!payload?.edge) return null
  const { edge, bucket } = payload
  const s = edge.summary ?? {}
  const members = edge.members ?? []

  return (
    <div
      ref={ref}
      className={`edge-tooltip${pinned ? ' pinned' : ''}`}
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
    >
      <div className="tt-head">
        <span className="tt-route">
          {edge.source}<span className="tt-arrow">⇄</span>{edge.target}
        </span>
        <span className="tt-tags">
          {(edge.netspaces ?? []).map((ns) => (
            <span className="tt-tag" key={ns}>{ns}</span>
          ))}
        </span>
        {pinned && (
          <button type="button" className="tt-close" title="Close" onClick={onClose}>×</button>
        )}
      </div>

      <div className="tt-metrics">
        {bucket && (
          <div className="tt-col">
            <div className="tt-col-title">
              cursor · <span className="tt-mono">{fmtAbsolute(bucket.t).slice(5)}</span>
            </div>
            <Metric label="loss" value={num(bucket.loss, 1, '%')} swatch={lossCss(bucket.loss)} />
            <Metric label="rtt" value={num(bucket.rttAvg, 1, 'ms')} />
            <Metric label="min/max" value={`${num(bucket.rttMin, 1)}/${num(bucket.rttMax, 1)}`} />
            <Metric label="s/r" value={`${bucket.sent}/${bucket.recv}`} />
          </div>
        )}
        <div className="tt-col">
          <div className="tt-col-title">range</div>
          <Metric label="loss" value={`${num(s.lossAvg, 1)}/${num(s.lossMax, 1, '%')}`} swatch={lossCss(s.lossMax ?? s.lossAvg)} />
          <Metric label="rtt" value={num(s.rttAvg, 1, 'ms')} />
          <Metric label="min/max" value={`${num(s.rttMin, 1)}/${num(s.rttMax, 1)}`} />
          <Metric label="s/r" value={`${s.sent ?? 0}/${s.recv ?? 0}`} />
        </div>
      </div>

      {members.length > 0 && (
        <div className="tt-conns">
          <div className="tt-conns-title">connections · {members.length}</div>
          <div className="tt-conns-list">
            {members.map((m, i) => (
              <div className="tt-conn" key={`${m.source}-${m.target}-${m.netspace}-${m.family}-${i}`}>
                <span className="tt-swatch" style={{ background: lossCss(m.summary.lossAvg) }} />
                <span className="tt-conn-route">{m.source}→{m.target}</span>
                <span className="tt-conn-meta">{m.netspace}·v{m.family}</span>
                <span className="tt-conn-loss">{num(m.summary.lossAvg, 1, '%')}</span>
                <span className="tt-conn-rtt">{num(m.summary.rttAvg, 1)}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="tt-foot">
        {pinned ? 'pinned · click empty space to close' : 'click to pin · drag to zoom time'}
      </div>
    </div>
  )
}

function Metric({ label, value, swatch }) {
  return (
    <div className="tt-metric">
      <span className="tt-metric-label">
        {swatch && <span className="tt-swatch" style={{ background: swatch }} />}
        {label}
      </span>
      <span className="tt-metric-value">{value}</span>
    </div>
  )
}
