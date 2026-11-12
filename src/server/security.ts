// The request guards: JSON replies and errors, Host/Origin checks, basic auth, body limits and rate limits.

import {timingSafeEqual} from 'node:crypto'
import http from 'node:http'
import {MINUTE, type ServerState} from './state.js'

const MAX_BODY = 16 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers})
  res.end(JSON.stringify(body))
}

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

/**
 * Only this machine's browser gets in: the Host check stops DNS rebinding,
 * the Origin check stops other websites from driving the API, and requiring
 * a JSON body makes cross-site POSTs need a preflight we never grant.
 */
export function checkRequest(state: ServerState, req: http.IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (state.hosted) {
    // public server: the DNS-rebinding check doesn't apply, but other
    // websites still mustn't drive the API — the Origin must be this site
    const origin = req.headers.origin
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        // unparseable origin — rejected below
      }
      const own = [req.headers.host, req.headers['x-forwarded-host']].flat().filter(Boolean)
      if (!own.includes(originHost)) throw new HttpError(403, 'forbidden origin')
    }
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
      throw new HttpError(415, 'expected application/json')
    }
    return
  }
  if (!isLocalHost(host)) throw new HttpError(403, 'forbidden host')
  const origin = req.headers.origin
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).hostname
    } catch {
      // unparseable origin — rejected below
    }
    if (!isLocalHost(originHost) && !isLocalHost(`[${originHost}]`)) throw new HttpError(403, 'forbidden origin')
  }
  if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'expected application/json')
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Hosted + password: HTTP basic auth, so the browser asks once and remembers. */
export function checkPassword(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const password = state.hosted?.password
  if (!password) return true
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString()
    if (safeEqual(decoded.slice(decoded.indexOf(':') + 1), password)) return true
  }
  // every wrong password is metered: without this a guessing loop is unthrottled,
  // and the probe/download limits never see it because they sit behind this check
  const {allowed, retryAfterMs} = state.authLimiter.take(clientKey(state, req))
  if (!allowed) {
    const seconds = Math.max(1, Math.ceil((retryAfterMs ?? MINUTE) / 1000))
    throw new HttpError(429, 'Too many password attempts — wait a minute and try again.', {
      'retry-after': String(seconds),
    })
  }
  res.writeHead(401, {'www-authenticate': 'Basic realm="yoinks", charset="UTF-8"'})
  res.end('password required')
  return false
}

export async function readJson(req: http.IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > max) throw new HttpError(413, 'request too large')
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid json')
}

/** Who to meter. Behind a proxy every request looks like the proxy. */
function clientKey(state: ServerState, req: http.IncomingMessage): string {
  if (state.hosted?.trustProxy) {
    const header = req.headers['x-forwarded-for']
    const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim()
    if (first) return first
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/** Hosted only: a single loop mustn't be able to spawn yt-dlp without end. */
export function checkLimits(state: ServerState, req: http.IncomingMessage, pathname: string) {
  if (!state.hosted) return
  const limiter =
    req.method === 'POST' && pathname === '/api/probe'
      ? state.probeLimiter
      : req.method === 'POST' && pathname === '/api/download'
        ? state.downloadLimiter
        : undefined
  if (!limiter) return
  const {allowed, retryAfterMs} = limiter.take(clientKey(state, req))
  if (allowed) return
  const seconds = Math.max(1, Math.ceil((retryAfterMs ?? MINUTE) / 1000))
  throw new HttpError(429, 'Too many requests — wait a moment and try again.', {'retry-after': String(seconds)})
}
