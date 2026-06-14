// icmprut-server: UI + API host.
//
// Responsibilities:
//   - serve the built React SPA (dist/)
//   - expose a small JSON API that talks to InfluxDB on the client's behalf,
//     keeping the bearer token server-side and coalescing/caching identical
//     queries (groundwork for the planned multi-user mode)
//
// Pure Node 26 stdlib (http) — no web framework, keeps the runtime image lean.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from './config.js'
import { getGraph, getMeta, cacheStats } from './graph-service.js'
import { InfluxError } from './influx.js'
import { serveStatic } from './static.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const staticRoot = path.isAbsolute(config.staticDir)
  ? config.staticDir
  : path.join(projectRoot, config.staticDir)

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      throw new Error('Request body too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function logRequest(req, status, startedAt) {
  const ms = Date.now() - startedAt
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${status} (${ms}ms)`)
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, cache: cacheStats() })
    return true
  }

  if (url.pathname === '/api/meta' && req.method === 'GET') {
    const meta = await getMeta()
    sendJson(res, 200, meta)
    return true
  }

  if (url.pathname === '/api/graph' && (req.method === 'POST' || req.method === 'GET')) {
    let params
    if (req.method === 'POST') {
      params = await readJsonBody(req)
    } else {
      params = {
        from: url.searchParams.get('from') ?? 'now-15m',
        to: url.searchParams.get('to') ?? 'now',
        filters: {
          netspaces: url.searchParams.get('netspaces')?.split(',').filter(Boolean),
          families: url.searchParams.get('families')?.split(',').filter(Boolean),
        },
        minLoss: url.searchParams.get('minLoss'),
        host: url.searchParams.get('host'),
      }
    }
    const graph = await getGraph({
      from: params.from ?? 'now-15m',
      to: params.to ?? 'now',
      filters: params.filters ?? {},
      maxBuckets: params.maxBuckets,
      minLoss: params.minLoss,
      host: params.host,
    })
    sendJson(res, 200, graph)
    return true
  }

  return false
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now()
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url)
      if (!handled) sendJson(res, 404, { error: 'Not found' })
      logRequest(req, res.statusCode, startedAt)
      return
    }

    const served = await serveStatic(staticRoot, url.pathname, res)
    if (!served) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found (frontend not built — run `npm run build`)')
    }
    logRequest(req, res.statusCode, startedAt)
  } catch (err) {
    const status = err instanceof InfluxError ? err.status ?? 502 : 500
    if (!res.headersSent) {
      sendJson(res, status, { error: err?.message ?? 'Internal error' })
    } else {
      res.end()
    }
    logRequest(req, status, startedAt)
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.method} ${req.url}:`, err?.message ?? err)
  }
})

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `icmprut-server listening on http://${config.host}:${config.port} ` +
      `(env=${config.nodeEnv}, influx=${config.influx.url}, db=${config.influx.db}, static=${staticRoot})`,
  )
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
