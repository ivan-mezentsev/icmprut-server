import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import GraphCanvas from './components/GraphCanvas.jsx'
import TimePicker from './components/TimePicker.jsx'
import NetspaceFilter from './components/NetspaceFilter.jsx'
import LossThresholdPicker from './components/LossThresholdPicker.jsx'
import EdgeTooltip from './components/EdgeTooltip.jsx'
import LossLegend from './components/LossLegend.jsx'
import NetworkQualityStrip from './components/NetworkQualityStrip.jsx'
import { useGraphData } from './hooks/useGraphData.js'
import { fetchMeta } from './lib/api.js'
import { DEFAULT_RANGE, describeRange, fmtDuration, isRelative } from './lib/time.js'
import { DEFAULT_LOSS_THRESHOLD } from './lib/loss-threshold.js'
import {
  readLossFromUrl,
  readHostFromUrl,
  readNetspacesFromUrl,
  readRangeFromUrl,
  writeUrlState,
} from './lib/url-state.js'

export default function App() {
  const [range, setRange] = useState(() => readRangeFromUrl(DEFAULT_RANGE))
  const [meta, setMeta] = useState(null)
  const [selectedNs, setSelectedNs] = useState(null) // Set | null (=all)
  const [lossThreshold, setLossThreshold] = useState(() =>
    readLossFromUrl(DEFAULT_LOSS_THRESHOLD),
  )
  const [selectedHost, setSelectedHost] = useState(() => readHostFromUrl())
  const [hoverPayload, setHoverPayload] = useState(null)
  const [pinnedPayload, setPinnedPayload] = useState(null)
  const stageRef = useRef(null)
  const [stageSize, setStageSize] = useState(null)

  // Load metadata (node universe + available netspaces) once.
  useEffect(() => {
    const controller = new AbortController()
    fetchMeta(controller.signal)
      .then((m) => {
        setMeta(m)
        setSelectedNs((prev) => prev ?? readNetspacesFromUrl(m.netspaces))
      })
      .catch(() => {
        /* surfaced via graph error path anyway */
      })
    return () => controller.abort()
  }, [])

  // Keep browser back/forward compatible with the URL state.
  useEffect(() => {
    const onPopState = () => {
      setRange(readRangeFromUrl(DEFAULT_RANGE))
      if (meta?.netspaces) setSelectedNs(readNetspacesFromUrl(meta.netspaces))
      setLossThreshold(readLossFromUrl(DEFAULT_LOSS_THRESHOLD))
      setSelectedHost(readHostFromUrl())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [meta])

  // Grafana-style shareable URL: from/to plus repeated var-netspace values.
  useEffect(() => {
    if (!meta || !selectedNs) return
    writeUrlState({
      range,
      selectedNetspaces: selectedNs,
      availableNetspaces: meta.netspaces,
      lossThreshold,
      host: selectedHost,
    })
  }, [range, selectedNs, meta, lossThreshold, selectedHost])

  const filters = useMemo(() => {
    if (!meta || !selectedNs) return {}
    // Only send netspaces when it's a real subset (smaller payload + clearer cache key).
    if (selectedNs.size === meta.netspaces.length) return {}
    return { netspaces: [...selectedNs] }
  }, [meta, selectedNs])

  const { data, loading, error, refresh } = useGraphData(
    range,
    filters,
    lossThreshold,
    selectedHost,
  )

  // Track stage size for tooltip clamping.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setStageSize({ width: r.width, height: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onRangeSelect = useCallback((next) => {
    // Brush along an edge → absolute zoom for the whole selection.
    setRange({ from: next.from, to: next.to })
  }, [])

  const availableNs = meta?.netspaces ?? []
  const selected = selectedNs ?? new Set(availableNs)

  const stats = useMemo(() => {
    if (!data) return null
    return {
      nodes: data.nodes.length,
      links: data.links.length,
      bucket: data.bucketSeconds,
    }
  }, [data])

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🐙</span>
          <div className="brand-text">
            <h1>icmprut</h1>
            <span className="brand-sub">ICMP sprut · live network cloud</span>
          </div>
        </div>

        <div className="controls">
          <NetspaceFilter
            available={availableNs}
            selected={selected}
            onChange={setSelectedNs}
          />
          <LossThresholdPicker value={lossThreshold} onChange={setLossThreshold} />
          <TimePicker range={range} onChange={setRange} />
          <button
            className="refresh-btn"
            type="button"
            onClick={refresh}
            title="Refresh"
            disabled={loading}
          >
            {loading ? '…' : '⟳'}
          </button>
        </div>

        <NetworkQualityStrip graph={data} onRangeSelect={onRangeSelect} />
      </header>

      <main className="stage" ref={stageRef}>
        {error && (
          <div className="banner error">
            <strong>InfluxDB error:</strong> {error}
            <button type="button" onClick={refresh}>Retry</button>
          </div>
        )}

        {data && (
          <GraphCanvas
            graph={data}
            activeLinkId={pinnedPayload?.edge?.id ?? null}
            selectedHost={selectedHost}
            onHostSelect={setSelectedHost}
            onEdgeHover={setHoverPayload}
            onEdgePin={setPinnedPayload}
            onRangeSelect={onRangeSelect}
          />
        )}

        {!data && !error && (
          <div className="banner loading">Loading network cloud…</div>
        )}

        <EdgeTooltip
          payload={pinnedPayload ?? hoverPayload}
          pinned={Boolean(pinnedPayload)}
          containerSize={stageSize}
          onClose={() => setPinnedPayload(null)}
        />

        <div className="overlay-bl">
          <LossLegend />
        </div>

        {stats && (
          <div className="overlay-tr">
            <div className="stat-pill">
              <span>{stats.nodes}</span> nodes
            </div>
            <div className="stat-pill">
              <span>{stats.links}</span> links
            </div>
            <div className="stat-pill">
              {fmtDuration(stats.bucket * 1000)} buckets
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span className={`live-indicator${isRelative(range.to) ? ' on' : ''}`}>
          {isRelative(range.to) ? '● live' : '◌ static'}
        </span>
        <span className="status-range">{describeRange(range.from, range.to)}</span>
        {loading && <span className="status-loading">querying…</span>}
        <span className="status-hint">
          Scroll / pinch to zoom · drag empty space to pan · hover a link for values · drag along a link to zoom time · double-click to fit
        </span>
      </footer>
    </div>
  )
}