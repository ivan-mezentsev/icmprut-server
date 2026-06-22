// Frontend API client. All data flows through our own Node server, never
// straight to InfluxDB, so the token stays server-side.

async function postJson(path, body, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Request failed: ${res.status}`)
  }
  return res.json()
}

async function getJson(path, signal) {
  const res = await fetch(path, { signal })
  if (!res.ok) throw new Error(`Request failed: ${res.status}`)
  return res.json()
}

/**
 * Metadata (node universe + available netspaces/families) is scoped to the same
 * time window as the graph, so the filter source matches what is on screen.
 * @param {{ from: string|number, to: string|number }} range
 */
export function fetchMeta(range, signal) {
  const params = new URLSearchParams({
    from: String(range.from),
    to: String(range.to),
  })
  return getJson(`/api/meta?${params.toString()}`, signal)
}

/**
 * @param {{ from: string|number, to: string|number, filters: object, minLoss?: number, host?: string|null }} params
 */
export function fetchGraph(params, signal) {
  return postJson('/api/graph', params, signal)
}
