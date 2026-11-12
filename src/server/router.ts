// The HTTP surface: the route table and one handler per endpoint. Each handler throws `HttpError`.

import {randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {isProbablyUrl} from '../lib/platforms.js'
import {assertPublicUrlResolved} from '../lib/ssrf.js'
import {buildChoices, buildPlaylistChoices, isPlaylist, playlistSize, probe, PROBE_TIMEOUT_MS} from '../lib/ytdlp.js'
import {saveStored} from './components.js'
import {dropJob, jobsRunning, runJob, sweep} from './jobs.js'
import {checkLimits, checkPassword, checkRequest, HttpError, readJson, sendJson} from './security.js'
import {serveStatic} from './static.js'
import type {Job, Probe, ServerState} from './state.js'
import {probeView, settingsView} from './views.js'
import {autoUpdateTick, checkLatest, componentsView, getYtDlp, handleCookies, updateYtDlp} from './ytdlp-setup.js'
import {listFiles, writeZip, zipSize} from './zip.js'

/** Each stored probe holds a metadata file in /tmp — past this, the oldest go. */
const MAX_STORED_PROBES = 500

async function handleProbe(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse) {
  const {url} = await readJson(req)
  if (typeof url !== 'string' || !isProbablyUrl(url.trim())) {
    throw new HttpError(400, 'That doesn’t look like a link — paste a full URL.')
  }
  const target = url.trim()
  // hosted: yt-dlp would fetch this from the server's own network position
  if (state.hosted) {
    try {
      await assertPublicUrlResolved(target)
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error))
    }
    if (state.activeProbes >= state.hosted.maxProbes) {
      throw new HttpError(429, 'The server is busy — try again in a minute.', {'retry-after': '30'})
    }
    if (state.probes.size >= MAX_STORED_PROBES) sweep(state)
    if (state.probes.size >= MAX_STORED_PROBES) {
      throw new HttpError(429, 'Too many links open — try again in a minute.')
    }
  }
  // a visitor who closes the tab shouldn't leave yt-dlp extracting
  const controller = new AbortController()
  const abandon = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', abandon)
  state.activeProbes++
  let result
  try {
    result = await probe(await getYtDlp(state), target, {signal: controller.signal, timeoutMs: PROBE_TIMEOUT_MS})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ ${target}: ${message}`)
    throw new HttpError(422, message)
  } finally {
    state.activeProbes--
    res.off('close', abandon)
  }
  const {info, infoJsonPath} = result
  if (state.hosted && isPlaylist(info) && playlistSize(info) > state.hosted.maxPlaylist) {
    void fs.rm(infoJsonPath, {force: true})
    throw new HttpError(
      422,
      `That playlist has ${playlistSize(info)} items — this server takes up to ${state.hosted.maxPlaylist}.`,
    )
  }
  const entry: Probe = {
    id: randomUUID(),
    url: url.trim(),
    info,
    infoJsonPath,
    choices: isPlaylist(info) ? buildPlaylistChoices(info) : buildChoices(info),
    createdAt: Date.now(),
  }
  state.probes.set(entry.id, entry)
  sendJson(res, 200, probeView(entry))
}

async function handleDownload(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse) {
  const {probeId, choice: index} = await readJson(req)
  const entry = typeof probeId === 'string' ? state.probes.get(probeId) : undefined
  if (!entry) throw new HttpError(404, 'That link expired — paste it again.')
  const choice = typeof index === 'number' ? entry.choices[index] : undefined
  if (!choice) throw new HttpError(400, 'unknown format')

  const job: Job = {
    id: randomUUID(),
    controller: new AbortController(),
    history: [],
    lastProgressAt: 0,
    listeners: new Set(),
    saved: 0,
    finished: false,
    createdAt: Date.now(),
  }
  if (state.hosted) {
    if (jobsRunning(state) >= state.hosted.maxJobs) {
      throw new HttpError(429, 'The server is busy — try again in a minute.')
    }
    job.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-'))
  }
  state.jobs.set(job.id, job)
  void runJob(state, job, entry, choice)
  sendJson(res, 200, {jobId: job.id})
}

function handleEvents(job: Job, res: http.ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  // send the headers now. writeHead alone does not flush them, so a subscriber
  // that connects before the first progress event would get no response at all
  // until one arrived — which for a quiet or hung download is never.
  res.flushHeaders()
  // a finished job already pushed its terminal event — replaying the last
  // progress tick after it would tell the UI to go back to "downloading"
  const replay = job.finished ? job.history : [...job.history, ...(job.lastProgress ? [job.lastProgress] : [])]
  for (const event of replay) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  if (job.finished) {
    res.end()
    return
  }
  job.listeners.add(res)
  res.on('close', () => job.listeners.delete(res))
}

const FILE_MIME: Record<string, string> = {'.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4'}

async function handleFile(state: ServerState, job: Job, res: http.ServerResponse) {
  if (!state.hosted || !job.result) throw new HttpError(409, 'nothing to download')
  const {path: target, isFolder} = job.result
  const gone = new HttpError(410, 'That file expired — yoink it again.')
  const headers = (name: string, type: string, size?: number) => ({
    'content-type': type,
    ...(size === undefined ? {} : {'content-length': size}),
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  })

  if (isFolder) {
    // a playlist: one zip of the album folder, built as it streams
    const names = await listFiles(target).catch(() => [])
    if (names.length === 0) throw gone
    const size = await zipSize(target, names)
    if (size === undefined) throw new HttpError(413, 'That playlist is too big to zip.')
    res.writeHead(200, headers(`${path.basename(target)}.zip`, 'application/zip', size))
    res.on('close', () => res.destroy())
    await writeZip(target, names, res, () => res.destroyed).catch(() => res.destroy())
    return
  }

  const size = (await fs.stat(target).catch(() => undefined))?.size
  if (size === undefined) throw gone
  res.writeHead(
    200,
    headers(path.basename(target), FILE_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream', size),
  )
  const stream = createReadStream(target)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

export async function route(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse) {
  // a protocol-relative target (`//host/…`) makes the parser throw — that's a
  // malformed request from the client, not a server fault
  let pathname: string
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    throw new HttpError(400, 'bad request')
  }
  if (state.hosted && pathname === '/healthz') {
    res.writeHead(200, {'content-type': 'text/plain'}).end('ok')
    return
  }
  checkRequest(state, req)
  if (!checkPassword(state, req, res)) return
  checkLimits(state, req, pathname)

  if (pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, settingsView(state))
  if (state.hosted && /^\/api\/(choose-folder|components\/(check|update|auto-update))$/.test(pathname)) {
    throw new HttpError(403, 'not available on this server')
  }
  if (state.hosted && pathname === '/api/cookies' && (req.method === 'POST' || req.method === 'DELETE')) {
    return handleCookies(state, req, res)
  }
  if (pathname === '/api/choose-folder' && req.method === 'POST') {
    await readJson(req)
    // opens the OS folder dialog on this machine; resolves when it's closed
    const picked = await state.osHooks.chooseFolder(state.outDir)
    if (picked) {
      state.outDir = picked
      await saveStored({outDir: picked})
    }
    return sendJson(res, 200, settingsView(state))
  }
  if (pathname === '/api/components' && req.method === 'GET') return sendJson(res, 200, await componentsView(state))
  if (pathname === '/api/components/check' && req.method === 'POST') {
    await readJson(req)
    try {
      await checkLatest(state)
    } catch (error) {
      state.yt.error = error instanceof Error ? error.message : String(error)
    }
    return sendJson(res, 200, await componentsView(state))
  }
  if (pathname === '/api/components/update' && req.method === 'POST') {
    await readJson(req)
    // a pinned binary is someone else's to update — replacing it would defeat the point
    if (state.yt.pinned) {
      throw new HttpError(403, 'This yoinks runs the yt-dlp binary it was given — update that one instead.')
    }
    await updateYtDlp(state)
    return sendJson(res, 200, await componentsView(state))
  }
  if (pathname === '/api/components/auto-update' && req.method === 'POST') {
    const {enabled} = await readJson(req)
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'expected {enabled: boolean}')
    state.yt.autoUpdate = enabled
    await saveStored({autoUpdate: enabled})
    if (enabled) void autoUpdateTick(state)
    return sendJson(res, 200, await componentsView(state))
  }
  if (pathname === '/api/probe' && req.method === 'POST') return handleProbe(state, req, res)
  if (pathname === '/api/download' && req.method === 'POST') return handleDownload(state, req, res)

  const jobMatch = /^\/api\/jobs\/([\w-]+)(\/events|\/reveal|\/file)?$/.exec(pathname)
  if (jobMatch) {
    const job = state.jobs.get(jobMatch[1]!)
    // finished jobs clean up after themselves, so a late cancel is already done
    if (!job && req.method === 'DELETE' && !jobMatch[2]) {
      res.writeHead(204).end()
      return
    }
    if (!job) throw new HttpError(404, 'This download is gone — start it again.')
    if (req.method === 'DELETE' && !jobMatch[2]) {
      dropJob(state, job)
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && jobMatch[2] === '/events') return handleEvents(job, res)
    if (req.method === 'GET' && jobMatch[2] === '/file') return handleFile(state, job, res)
    if (req.method === 'POST' && jobMatch[2] === '/reveal') {
      await readJson(req)
      if (!job.result) throw new HttpError(409, 'not finished yet')
      state.osHooks.reveal(job.result.path, job.result.isFolder)
      res.writeHead(204).end()
      return
    }
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
  return serveStatic(state, pathname, res)
}
