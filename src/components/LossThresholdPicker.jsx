import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_LOSS_THRESHOLD,
  LOSS_PRESETS,
  clampLoss,
  fmtLoss,
} from '../lib/loss-threshold.js'

/**
 * Packet-loss threshold picker, modelled on the time picker.
 *
 * Left column: an exact value field (hundredth precision) with an Apply button.
 * Right column: a preset list (1/3/5/10/20/30/50/80/90/100), default 5%.
 *
 * The threshold only declutters: links whose worst-case loss is below it are
 * not loaded and not drawn. No drawing/business logic of the graph changes.
 *
 * Props: value (number %), onChange(number %).
 */
export default function LossThresholdPicker({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const [text, setText] = useState(() => fmtLoss(value ?? DEFAULT_LOSS_THRESHOLD))

  // Re-seed the exact field from the active value when it changes externally,
  // but only while closed so typing is never clobbered mid-edit.
  useEffect(() => {
    if (open) return
    setText(fmtLoss(value ?? DEFAULT_LOSS_THRESHOLD))
  }, [value, open])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const parsed = useMemo(() => clampLoss(text), [text])
  const valid = parsed != null && /^\d*\.?\d*$/.test(text.trim()) && text.trim() !== ''
  const canApply = valid

  const applyPreset = (preset) => {
    onChange(clampLoss(preset))
    setOpen(false)
  }

  const applyExact = () => {
    if (!canApply) return
    onChange(parsed)
    setOpen(false)
  }

  const current = clampLoss(value) ?? DEFAULT_LOSS_THRESHOLD

  return (
    <div className="timepicker losspicker" ref={ref}>
      <button
        className="tp-trigger"
        onClick={() => setOpen((v) => !v)}
        type="button"
        title="Packet-loss threshold"
      >
        <span className="tp-label">≥ {fmtLoss(current)}% loss</span>
        <span className="tp-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="tp-popover loss-popover">
          <div className="tp-absolute">
            <h4>Exact threshold</h4>
            <div className="tp-field">
              <span className="tp-field-label">Loss ≥ (%)</span>
              <div className="tp-field-row">
                <input
                  type="text"
                  inputMode="decimal"
                  spellCheck={false}
                  className={valid ? '' : 'invalid'}
                  placeholder="0.00 – 100.00"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyExact()}
                />
              </div>
            </div>
            <button className="tp-apply" type="button" onClick={applyExact} disabled={!canApply}>
              Apply
            </button>
            <p className={`tp-hint${canApply ? '' : ' bad'}`}>
              {valid
                ? `Show links with worst loss ≥ ${fmtLoss(parsed)}%`
                : 'Enter a number 0–100 (hundredths allowed)'}
            </p>
          </div>

          <div className="tp-relative">
            <h4>Presets</h4>
            <ul>
              {LOSS_PRESETS.map((p) => {
                const selected = clampLoss(p) === current
                return (
                  <li key={p}>
                    <button
                      type="button"
                      className={selected ? 'selected' : ''}
                      onClick={() => applyPreset(p)}
                    >
                      ≥ {p}%
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
