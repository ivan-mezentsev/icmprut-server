// Minimal static file server for the built SPA. No external deps: just enough
// to serve dist/ with correct content types and SPA fallback to index.html.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Serve a file from `rootDir` matching `urlPath`, falling back to index.html for
 * client-side routes. Returns true if a response was sent.
 * @param {string} rootDir
 * @param {string} urlPath
 * @param {import('node:http').ServerResponse} res
 */
export async function serveStatic(rootDir, urlPath, res) {
  const clean = decodeURIComponent(urlPath.split('?')[0])
  let rel = path.normalize(clean).replace(/^(\.\.[/\\])+/, '')
  if (rel === '/' || rel === '' || rel === '.') rel = 'index.html'

  const candidate = path.join(rootDir, rel)
  // Prevent path traversal outside rootDir.
  if (!candidate.startsWith(path.resolve(rootDir))) {
    res.writeHead(403).end('Forbidden')
    return true
  }

  const file = await resolveFile(candidate)
  if (file) {
    sendFile(file, res)
    return true
  }

  // SPA fallback.
  const indexPath = path.join(rootDir, 'index.html')
  const index = await resolveFile(indexPath)
  if (index) {
    sendFile(index, res)
    return true
  }
  return false
}

async function resolveFile(candidate) {
  try {
    const info = await stat(candidate)
    if (info.isFile()) return candidate
    if (info.isDirectory()) {
      const indexFile = path.join(candidate, 'index.html')
      const idxInfo = await stat(indexFile)
      if (idxInfo.isFile()) return indexFile
    }
  } catch {
    /* not found */
  }
  return null
}

function sendFile(filePath, res) {
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=3600',
  })
  createReadStream(filePath).pipe(res)
}
