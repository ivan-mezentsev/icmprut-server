// Thin InfluxDB 3 Core SQL client built on the native fetch (Node 26).
// Only read access is needed: POST /api/v3/query_sql with a bound parameter
// free SQL string and JSON output. The bearer token never leaves the server.

import config from './config.js'

export class InfluxError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'InfluxError'
    this.status = status
    this.body = body
  }
}

/**
 * Execute a read-only SQL query against InfluxDB and return parsed JSON rows.
 * @param {string} sql
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function querySql(sql) {
  const { url, token, db, timeoutMs } = config.influx
  const endpoint = `${url}/api/v3/query_sql`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ db, q: sql, format: 'json' }),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') {
      throw new InfluxError(`InfluxDB query timed out after ${timeoutMs}ms`, { status: 504 })
    }
    throw new InfluxError(`InfluxDB request failed: ${err?.message ?? err}`, { status: 502 })
  }
  clearTimeout(timer)

  const text = await response.text()
  if (!response.ok) {
    const snippet = text.slice(0, 500)
    throw new InfluxError(`InfluxDB returned ${response.status}: ${snippet}`, {
      status: response.status === 401 || response.status === 403 ? 502 : 502,
      body: snippet,
    })
  }

  if (!text) return []
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new InfluxError(`InfluxDB returned non-JSON payload: ${err?.message ?? err}`, {
      status: 502,
    })
  }
}
