import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RELATIVE_PRESETS,
  describeRange,
  fmtAbsolute,
  isRelative,
  parseAbsoluteLocal,
  resolveBoundaryMs,
} from '../lib/time.js'

const HOUR_MS = 60 * 60 * 1000

/**
 * Grafana-style time picker.
 *
 * The absolute inputs are plain TEXT fields with a strict 24h
 * `YYYY-MM-DD HH:mm:ss` local format — no native <datetime-local> calendar
 * popup, no 12h/locale surprises — so the from/to can be typed and nudged with
 * the keyboard, and shifted by ±1h with buttons. Invalid input is flagged
 * instead of silently snapping to now.
 *
 * Props: range {from,to}, onChange({from,to}).
 */
export default function TimePicker({ range, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const [absFrom, setAbsFrom] = useState(() => fmtAbsolute(resolveBoundaryMs(range.from)))
  const [absTo, setAbsTo] = useState(() => fmtAbsolute(resolveBoundaryMs(range.to)))

  // Re-seed the text fields from the active range whenever it changes (preset
  // click, brush zoom, etc.), but only while the popover is closed so typing is
  // never clobbered mid-edit.
  useEffect(() => {
    if (open) return
    setAbsFrom(fmtAbsolute(resolveBoundaryMs(range.from)))
    setAbsTo(fmtAbsolute(resolveBoundaryMs(range.to)))
  }, [range.from, range.to, open])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const fromMs = useMemo(() => parseAbsoluteLocal(absFrom), [absFrom])
  const toMs = useMemo(() => parseAbsoluteLocal(absTo), [absTo])
  const fromValid = fromMs != null
  const toValid = toMs != null
  const orderValid = fromValid && toValid && toMs > fromMs
  const canApply = fromValid && toValid && orderValid

  const applyPreset = (preset) => {
    onChange({ from: preset.from, to: preset.to })
    setOpen(false)
  }

  const applyAbsolute = () => {
    if (!canApply) return
    onChange({ from: fromMs, to: toMs })
    setOpen(false)
  }

  // Shift a boundary by whole hours, keeping it a valid string.
  const shiftFrom = (hours) => {
    const base = fromMs ?? resolveBoundaryMs(range.from)
    setAbsFrom(fmtAbsolute(base + hours * HOUR_MS))
  }
  const shiftTo = (hours) => {
    const base = toMs ?? resolveBoundaryMs(range.to)
    setAbsTo(fmtAbsolute(base + hours * HOUR_MS))
  }

  const label = describeRange(range.from, range.to)
  const live = isRelative(range.to)

  return (
    <div className="timepicker" ref={ref}>
      <button
        className={`tp-trigger${live ? ' tp-live' : ''}`}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="tp-icon" aria-hidden>🕑</span>
        <span className="tp-label">{label}</span>
        {live && <span className="tp-live-dot" title="Live (auto-refresh)" />}
        <span className="tp-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="tp-popover">
          <div className="tp-absolute">
            <h4>Absolute range</h4>

            <div className="tp-field">
              <span className="tp-field-label">From</span>
              <div className="tp-field-row">
                <button type="button" className="tp-nudge" title="−1 hour" onClick={() => shiftFrom(-1)}>−1h</button>
                <input
                  type="text"
                  inputMode="numeric"
                  spellCheck={false}
                  className={fromValid ? '' : 'invalid'}
                  placeholder="YYYY-MM-DD HH:mm:ss"
                  value={absFrom}
                  onChange={(e) => setAbsFrom(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyAbsolute()}
                />
                <button type="button" className="tp-nudge" title="+1 hour" onClick={() => shiftFrom(1)}>+1h</button>
              </div>
            </div>

            <div className="tp-field">
              <span className="tp-field-label">To</span>
              <div className="tp-field-row">
                <button type="button" className="tp-nudge" title="−1 hour" onClick={() => shiftTo(-1)}>−1h</button>
                <input
                  type="text"
                  inputMode="numeric"
                  spellCheck={false}
                  className={toValid ? '' : 'invalid'}
                  placeholder="YYYY-MM-DD HH:mm:ss"
                  value={absTo}
                  onChange={(e) => setAbsTo(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyAbsolute()}
                />
                <button type="button" className="tp-nudge" title="+1 hour" onClick={() => shiftTo(1)}>+1h</button>
              </div>
            </div>

            <button className="tp-apply" type="button" onClick={applyAbsolute} disabled={!canApply}>
              Apply range
            </button>
            <p className={`tp-hint${canApply ? '' : ' bad'}`}>
              {!fromValid || !toValid
                ? 'Use 24h format: YYYY-MM-DD HH:mm:ss'
                : !orderValid
                  ? '“To” must be later than “From”'
                  : `Span ${describeSpan(toMs - fromMs)}`}
            </p>
          </div>

          <div className="tp-relative">
            <h4>Relative ranges</h4>
            <ul>
              {RELATIVE_PRESETS.map((p) => {
                const selected = p.from === range.from && p.to === range.to
                return (
                  <li key={p.label}>
                    <button
                      type="button"
                      className={selected ? 'selected' : ''}
                      onClick={() => applyPreset(p)}
                    >
                      {p.label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

function describeSpan(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.round((min / 60) * 10) / 10
  if (h < 48) return `${h} h`
  return `${Math.round((h / 24) * 10) / 10} d`
}
