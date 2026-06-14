import { useMemo, useRef, useState } from 'react'
import { fmtAbsolute } from '../lib/time.js'
import { lossCss, noDataCss } from '../lib/loss-color.js'

const DRAG_THRESHOLD_PX = 4

function clamp01(value) {
  return Math.max(0, Math.min(1, value))
}

function num(value, digits = 1, suffix = '') {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}${suffix}`
}

function aggregateQuality(graph) {
  const from = graph?.range?.from
  const to = graph?.range?.to
  const stepMs = (graph?.bucketSeconds ?? 60) * 1000
  if (!graph || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { from: 0, to: 0, stepMs, points: [] }
  }

  const byTime = new Map()
  for (const link of graph.links ?? []) {
    for (const bucket of link.buckets ?? []) {
      if (!Number.isFinite(bucket.t)) continue
      let point = byTime.get(bucket.t)
      if (!point) {
        point = {
          t: bucket.t,
          sent: 0,
          recv: 0,
          links: 0,
          badLinks: 0,
          lossMax: null,
          lossSum: 0,
          lossCount: 0,
        }
        byTime.set(bucket.t, point)
      }
      point.sent += bucket.sent ?? 0
      point.recv += bucket.recv ?? 0
      point.links += 1
      if (bucket.loss != null && !Number.isNaN(bucket.loss)) {
        point.lossMax = point.lossMax == null ? bucket.loss : Math.max(point.lossMax, bucket.loss)
        point.lossSum += bucket.loss
        point.lossCount += 1
        if (bucket.loss > 0) point.badLinks += 1
      }
    }
  }

  const points = [...byTime.values()]
    .map((point) => ({
      ...point,
      lossAvg: point.sent > 0
        ? Math.max(0, ((point.sent - point.recv) * 100) / point.sent)
        : point.lossCount > 0 ? point.lossSum / point.lossCount : null,
    }))
    .sort((a, b) => a.t - b.t)

  return { from, to, stepMs, points }
}

function findNearestPoint(points, time) {
  if (!points.length) return null
  let best = points[0]
  let bestDist = Math.abs(best.t - time)
  for (let i = 1; i < points.length; i += 1) {
    const dist = Math.abs(points[i].t - time)
    if (dist < bestDist) {
      best = points[i]
      bestDist = dist
    }
  }
  return best
}

export default function NetworkQualityStrip({ graph, onRangeSelect }) {
  const ref = useRef(null)
  const dragRef = useRef(null)
  const quality = useMemo(() => aggregateQuality(graph), [graph])
  const [hover, setHover] = useState(null)
  const [brush, setBrush] = useState(null)

  const span = Math.max(1, quality.to - quality.from)
  const hasData = quality.points.length > 0

  const localX = (evt) => {
    const rect = ref.current.getBoundingClientRect()
    return Math.max(0, Math.min(rect.width, evt.clientX - rect.left))
  }

  const timeAtX = (x) => {
    const rect = ref.current.getBoundingClientRect()
    return quality.from + clamp01(x / Math.max(1, rect.width)) * span
  }

  const updateHover = (x) => {
    const rect = ref.current.getBoundingClientRect()
    const time = timeAtX(x)
    const point = findNearestPoint(quality.points, time)
    const half = rect.width > 160 ? 74 : 8
    setHover({ x: Math.max(half, Math.min(rect.width - half, x)), time, point })
  }

  const onPointerMove = (evt) => {
    if (!ref.current || !quality.to) return
    const x = localX(evt)
    updateHover(x)
    if (dragRef.current) {
      dragRef.current.x1 = x
      setBrush({ x0: dragRef.current.x0, x1: x })
    }
  }

  const onPointerDown = (evt) => {
    if (!hasData || !ref.current) return
    const x = localX(evt)
    ref.current.setPointerCapture(evt.pointerId)
    dragRef.current = { x0: x, x1: x }
    setBrush({ x0: x, x1: x })
    updateHover(x)
  }

  const onPointerUp = (evt) => {
    if (ref.current?.hasPointerCapture?.(evt.pointerId)) {
      ref.current.releasePointerCapture(evt.pointerId)
    }
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || !brush) {
      setBrush(null)
      return
    }
    const x1 = drag.x1 ?? brush.x1 ?? drag.x0
    const moved = Math.abs(x1 - drag.x0)
    if (moved > DRAG_THRESHOLD_PX) {
      const lo = Math.min(drag.x0, x1)
      const hi = Math.max(drag.x0, x1)
      const step = quality.stepMs || 60_000
      const from = Math.floor(timeAtX(lo) / step) * step
      const to = Math.ceil(timeAtX(hi) / step) * step
      if (to > from) onRangeSelect?.({ from, to })
    }
    setBrush(null)
  }

  const brushLeft = brush ? Math.min(brush.x0, brush.x1) : 0
  const brushWidth = brush ? Math.abs(brush.x1 - brush.x0) : 0

  return (
    <div
      ref={ref}
      className={`quality-strip${hasData ? '' : ' empty'}`}
      onPointerEnter={onPointerMove}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (!dragRef.current) setHover(null)
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="quality-track">
        {quality.points.map((point) => {
          const left = clamp01((point.t - quality.from) / span) * 100
          const right = clamp01((point.t + quality.stepMs - quality.from) / span) * 100
          const width = Math.max(0.18, right - left)
          const loss = point.lossMax ?? point.lossAvg
          return (
            <span
              key={point.t}
              className="quality-segment"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                background: loss == null ? noDataCss(0.65) : lossCss(loss, 0.95),
              }}
            />
          )
        })}
        {brush && <span className="quality-brush" style={{ left: brushLeft, width: brushWidth }} />}
      </div>

      {hover && (
        <div className="quality-hover" style={{ left: hover.x }}>
          <div className="qh-time">{fmtAbsolute(hover.point?.t ?? hover.time).slice(5)}</div>
          <div><span>worst</span><b>{num(hover.point?.lossMax, 1, '%')}</b></div>
          <div><span>avg</span><b>{num(hover.point?.lossAvg, 1, '%')}</b></div>
          <div><span>bad</span><b>{hover.point ? `${hover.point.badLinks}/${hover.point.links}` : '—'}</b></div>
        </div>
      )}
    </div>
  )
}