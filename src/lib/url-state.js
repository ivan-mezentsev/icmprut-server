const NETSPACE_VAR = 'var-netspace'

function currentUrl() {
  if (typeof window === 'undefined') return null
  return new URL(window.location.href)
}

function token(value) {
  if (value == null || value === '') return null
  return /^-?\d+$/.test(value) ? Number(value) : value
}

/** Read Grafana-compatible time range from URL query params. */
export function readRangeFromUrl(fallback) {
  const url = currentUrl()
  if (!url) return fallback
  const from = token(url.searchParams.get('from'))
  const to = token(url.searchParams.get('to'))
  if (from != null && to != null) return { from, to }

  const center = Number(url.searchParams.get('time'))
  const windowMs = Number(url.searchParams.get('time.window'))
  if (Number.isFinite(center) && Number.isFinite(windowMs) && windowMs > 0) {
    return { from: Math.round(center - windowMs / 2), to: Math.round(center + windowMs / 2) }
  }

  return fallback
}

/** Read Grafana-style repeated `var-netspace` values from the URL. */
export function readNetspacesFromUrl(available) {
  const url = currentUrl()
  const all = new Set(available)
  if (!url) return all

  const repeated = url.searchParams.getAll(NETSPACE_VAR)
  const legacy = url.searchParams.get('netspaces')?.split(',') ?? []
  const raw = [...repeated, ...legacy].map((v) => String(v).trim()).filter(Boolean)
  if (raw.length === 0 || raw.some((v) => v.toLowerCase() === 'all')) return all

  const allowed = new Set(available)
  const selected = raw.filter((v) => allowed.has(v))
  return selected.length > 0 ? new Set(selected) : all
}

/** Write Grafana-compatible URL state without reloading the page. */
export function writeUrlState({ range, selectedNetspaces, availableNetspaces }) {
  const url = currentUrl()
  if (!url || !range || !selectedNetspaces || !availableNetspaces) return

  url.searchParams.set('from', String(range.from))
  url.searchParams.set('to', String(range.to))
  url.searchParams.delete('time')
  url.searchParams.delete('time.window')
  url.searchParams.delete('netspaces')
  url.searchParams.delete(NETSPACE_VAR)

  if (selectedNetspaces.size < availableNetspaces.length) {
    for (const ns of availableNetspaces) {
      if (selectedNetspaces.has(ns)) url.searchParams.append(NETSPACE_VAR, ns)
    }
  }

  const next = `${url.pathname}${url.search}${url.hash}`
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== current) window.history.replaceState(null, '', next)
}