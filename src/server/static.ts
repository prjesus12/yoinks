// The built web app as files: MIME lookup, the trailing-separator containment check and the SPA fallback.

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {HttpError} from './security.js'
import type {ServerState} from './state.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export async function serveStatic(state: ServerState, pathname: string, res: http.ServerResponse) {
  const webDir = state.webDir
  // a malformed percent-encoding is a bad request, not a crash
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new HttpError(400, 'bad request')
  }
  const relative = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(webDir, relative)
  if (!file.startsWith(webDir)) throw new HttpError(404, 'not found')
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(webDir, 'index.html') // single-page app
  }
  let body: Buffer
  try {
    body = await fs.readFile(file)
  } catch {
    throw new HttpError(404, 'The web app isn’t built — run `npm run build` first.')
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    // hashed asset names never change; the page itself always revalidates
    'cache-control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  res.end(body)
}
