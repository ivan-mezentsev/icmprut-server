// Toggle which netspace link types are shown. Default: all enabled.

export default function NetspaceFilter({ available, selected, onChange }) {
  if (!available || available.length === 0) return null

  const toggle = (ns) => {
    const next = new Set(selected)
    if (next.has(ns)) {
      // Never let the user disable the last one to avoid an empty graph;
      // instead re-enable everything (acts as a "reset").
      next.delete(ns)
      if (next.size === 0) {
        onChange(new Set(available))
        return
      }
    } else {
      next.add(ns)
    }
    onChange(next)
  }

  const allOn = selected.size === available.length

  return (
    <div className="netfilter">
      <span className="netfilter-label">Link types</span>
      <div className="netfilter-chips">
        {available.map((ns) => {
          const on = selected.has(ns)
          return (
            <button
              key={ns}
              type="button"
              className={`chip${on ? ' on' : ''}`}
              onClick={() => toggle(ns)}
              title={on ? `Hide ${ns}` : `Show ${ns}`}
            >
              {ns}
            </button>
          )
        })}
        <button
          type="button"
          className="chip reset"
          onClick={() => onChange(new Set(available))}
          disabled={allOn}
          title={allOn ? 'All link types are already enabled' : 'Enable all link types'}
        >
          Reset
        </button>
      </div>
    </div>
  )
}
