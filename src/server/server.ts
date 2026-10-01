import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {addToHistory} from '../lib/history.js'
import {detectPlatform, isProbablyUrl, playlistUrlFor} from '../lib/platforms.js'
import {
  buildChoices,
  buildPlaylistChoices,
  download,
  ensureYtDlp,
  findFfmpeg,
  installManagedYtDlp,
  MANAGED_YTDLP,
  isPlaylist,
  playlistAlbum,
  playlistFolderName,
  playlistSize,
  probe,
  type DownloadChoice,
  type DownloadResult,
  type VideoInfo,
} from '../lib/ytdlp.js'
import {ffmpegView, isNewer, latestYtDlpVersion, loadStored, saveStored, ytDlpVersion} from './components.js'
import * as desktop from './desktop.js'
import type {ChoiceView, ComponentsView, JobEvent, ProbeView, Settings} from './types.js'

export type {ChoiceView, ComponentsView, JobEvent, ProbeView, Settings} from './types.js'

/** OS integration — the desktop app swaps in Electron's native versions. */
export type Desktop = {
  chooseFolder: (current: string) => Promise<string | undefined>
  reveal: (target: string, isFolder: boolean) => void
  revealLabel: string
  canChooseFolder: boolean
}

const DEFAULT_PORT = 4455
const TTL = 60 * 60 * 1000 // probes and finished jobs are dropped after an hour
const MAX_BODY = 16 * 1024
const DAY = 24 * 60 * 60 * 1000

let APP_VERSION = 'dev'
try {
  APP_VERSION = (createRequire(import.meta.url)('../package.json') as {version: string}).version
} catch {
  // running from source
}

type Probe = {
  id: string
  url: string
  info: VideoInfo
  infoJsonPath: string
  choices: DownloadChoice[]
  createdAt: number
}

type Job = {
  id: string
  controller: AbortController
  /** Everything but progress ticks, replayed to late subscribers. */
  history: JobEvent[]
  lastProgress?: JobEvent
  lastProgressAt: number
  listeners: Set<http.ServerResponse>
  saved: number
  /** The file, or the playlist's folder, once it's done. */
  result?: {path: string; isFolder: boolean}
  finished: boolean
  createdAt: number
}

const probes = new Map<string, Probe>()
const jobs = new Map<string, Job>()
/** Where downloads land — like the terminal UI, straight onto disk. */
let outDir = path.join(os.homedir(), 'Downloads')
let osHooks: Desktop = {
  chooseFolder: desktop.chooseFolder,
  reveal: desktop.reveal,
  revealLabel: desktop.revealLabel(),
  canChooseFolder: false,
}

const prettyPath = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p)

const settingsView = (): Settings => ({
  outDir: prettyPath(outDir),
  canChooseFolder: osHooks.canChooseFolder,
  revealLabel: osHooks.revealLabel,
})

// ---------------------------------------------------------------------------
// yt-dlp: found once, shared by every probe and download, updatable in place

const yt = {
  path: undefined as string | undefined,
  ready: undefined as Promise<string> | undefined,
  /** Use yoinks' own copy even when the system has one (the desktop app does). */
  managed: false,
  busy: false,
  error: undefined as string | undefined,
  latest: undefined as string | undefined,
  checkedAt: undefined as number | undefined,
  autoUpdate: true,
}

function getYtDlp(): Promise<string> {
  yt.ready ??= ensureYtDlp(() => (yt.busy = true), undefined, {preferManaged: yt.managed})
    .then(bin => {
      yt.path = bin
      yt.error = undefined
      return bin
    })
    .catch((error: unknown) => {
      yt.ready = undefined // let the next request try again
      yt.error = error instanceof Error ? error.message : String(error)
      throw error
    })
    .finally(() => (yt.busy = false))
  return yt.ready
}

async function checkLatest() {
  yt.latest = await latestYtDlpVersion()
  yt.checkedAt = Date.now()
  await saveStored({latest: yt.latest, lastCheck: yt.checkedAt})
}

/** Fetch the newest official yt-dlp and switch to it (from a system copy too). */
async function updateYtDlp() {
  if (yt.busy) return
  yt.busy = true
  yt.error = undefined
  try {
    const bin = await installManagedYtDlp()
    yt.path = bin
    yt.ready = Promise.resolve(bin)
    if (!yt.managed) {
      yt.managed = true
      await saveStored({managedYtDlp: true})
    }
  } catch (error) {
    yt.error = error instanceof Error ? error.message : String(error)
  } finally {
    yt.busy = false
  }
}

async function componentsView(): Promise<ComponentsView> {
  // don't hold the panel hostage to a first-run download
  const bin = yt.path ?? (yt.busy ? undefined : await getYtDlp().catch(() => undefined))
  return {
    appVersion: APP_VERSION,
    ytdlp: {
      version: bin ? await ytDlpVersion(bin) : undefined,
      latest: yt.latest,
      managed: yt.path === MANAGED_YTDLP,
      busy: yt.busy,
      error: yt.error,
      checkedAt: yt.checkedAt,
    },
    ffmpeg: await ffmpegView(),
    autoUpdate: yt.autoUpdate,
  }
}

/** Daily: keep yoinks' own yt-dlp current. A system install is left alone. */
async function autoUpdateTick() {
  if (!yt.autoUpdate || yt.busy) return
  // a running download holds the binary open (and Windows won't replace it)
  if ([...jobs.values()].some(job => !job.finished)) return
  try {
    const bin = await getYtDlp()
    if (bin !== MANAGED_YTDLP) return
    if (!yt.latest || Date.now() - (yt.checkedAt ?? 0) > DAY) await checkLatest()
    const current = await ytDlpVersion(bin)
    if (yt.latest && current && isNewer(yt.latest, current)) await updateYtDlp()
  } catch {
    // offline or rate-limited — try again next tick
  }
}

// ---------------------------------------------------------------------------
// views — what the browser gets to see. Choices stay server-side: the client
// only ever sends back an index, never yt-dlp arguments.

function thumbnailOf(info: VideoInfo): string | undefined {
  const pick = (list?: Array<{url: string; width?: number}>) =>
    list?.filter(t => t.url.startsWith('https://')).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url
  // a playlist's own thumbnail is often YouTube's generic placeholder — its
  // first video's is the real cover
  const first = pick(info.entries?.find(Boolean)?.thumbnails)
  return isPlaylist(info) ? (first ?? pick(info.thumbnails)) : (info.thumbnail ?? pick(info.thumbnails))
}

function choiceView(choice: DownloadChoice, index: number): ChoiceView {
  const parts = choice.label.split(' · ')
  const size = parts.find(part => part.startsWith('~'))
  const name =
    choice.kind === 'audio'
      ? choice.format.toUpperCase()
      : (/^\d+p/.exec(parts[0] ?? '')?.[0] ?? 'Best')
  const detail =
    choice.format === 'mp3'
      ? 'Plays everywhere'
      : choice.format === 'm4a'
        ? 'Original AAC, no re-encoding'
        : /^\d+p/.test(parts[0] ?? '')
          ? 'MP4 video'
          : 'MP4 video, highest quality'
  return {index, kind: choice.kind, format: choice.format, name, detail, size}
}

function probeView(probe: Probe): ProbeView {
  const {info} = probe
  const playlist = isPlaylist(info)
  const album = playlist ? playlistAlbum(info) : undefined
  const durations = playlist ? (info.entries ?? []).map(e => e?.duration ?? 0) : []
  return {
    id: probe.id,
    kind: playlist ? 'playlist' : 'video',
    title: playlist ? album!.album || info.title : info.title,
    author: playlist ? album!.artist : (info.uploader ?? info.channel),
    platform: detectPlatform(probe.url).label,
    duration: playlist ? (durations.every(Boolean) ? durations.reduce((a, b) => a + b, 0) : undefined) : info.duration,
    thumbnail: thumbnailOf(info),
    count: playlist ? playlistSize(info) : undefined,
    folder: playlist ? playlistFolderName(info) : undefined,
    playlistUrl: playlist ? undefined : playlistUrlFor(probe.url),
    choices: probe.choices.map((choice, index) => choiceView(choice, index)),
  }
}

// ---------------------------------------------------------------------------
// jobs

function emit(job: Job, event: JobEvent) {
  if (event.type === 'progress') {
    job.lastProgress = event
    // yt-dlp reports many times a second — a few updates are plenty
    const now = Date.now()
    if (now - job.lastProgressAt < 150) return
    job.lastProgressAt = now
  } else {
    job.history.push(event)
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of job.listeners) res.write(payload)
}

async function runJob(job: Job, probe: Probe, choice: DownloadChoice) {
  const handlers = {
    onProgress: (p: Parameters<Parameters<typeof download>[1]['onProgress']>[0]) =>
      emit(job, {
        type: 'progress',
        downloaded: p.downloadedBytes,
        total: p.totalBytes,
        speed: p.speed,
        eta: p.eta,
        part: p.part,
        parts: p.totalParts,
      }),
    onProcessing: () => emit(job, {type: 'processing'}),
    onItem: (item: number, total: number) => emit(job, {type: 'item', item, total}),
    onFile: (filepath: string) => {
      job.saved++
      emit(job, {type: 'file', index: job.saved - 1, name: path.basename(filepath)})
    },
  }
  const {signal} = job.controller
  try {
    const ffmpegLocation = await findFfmpeg()
    await fs.mkdir(outDir, {recursive: true})
    const base = {ytdlp: await getYtDlp(), ffmpegLocation, url: probe.url, choice, outDir}
    let result: DownloadResult
    try {
      result = await download({...base, infoJsonPath: probe.infoJsonPath}, handlers, signal)
    } catch (error) {
      if (signal.aborted || choice.playlistFolder) throw error
      // media urls in the cached info can expire — retry with a fresh extraction
      emit(job, {type: 'refreshing'})
      result = await download(base, handlers, signal)
    }
    addToHistory(probe.url)
    job.result = {path: result.filepath, isFolder: Boolean(choice.playlistFolder)}
    emit(job, {type: 'done', count: result.count, failed: result.failed, path: prettyPath(result.filepath)})
  } catch (error) {
    if (signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    // the terminal running --web is the only place to look when this goes wrong
    console.error(`✗ ${probe.url}: ${message}`)
    emit(job, {type: 'error', message})
  } finally {
    job.finished = true
    for (const res of job.listeners) res.end()
    job.listeners.clear()
  }
}

/** Downloads still running — the desktop app asks before quitting on them. */
export const activeDownloads = () => [...jobs.values()].filter(job => !job.finished).length

/** Cancel (a no-op once finished). download() removes its own partial files. */
function dropJob(job: Job) {
  job.controller.abort()
  jobs.delete(job.id)
  for (const res of job.listeners) res.end()
}

function sweep() {
  const cutoff = Date.now() - TTL
  for (const probe of probes.values()) {
    if (probe.createdAt < cutoff) {
      probes.delete(probe.id)
      void fs.rm(probe.infoJsonPath, {force: true})
    }
  }
  for (const job of jobs.values()) if (job.finished && job.createdAt < cutoff) dropJob(job)
}

// ---------------------------------------------------------------------------
// http

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(body))
}

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

/**
 * Only this machine's browser gets in: the Host check stops DNS rebinding,
 * the Origin check stops other websites from driving the API, and requiring
 * a JSON body makes cross-site POSTs need a preflight we never grant.
 */
function checkRequest(req: http.IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY) throw new HttpError(413, 'request too large')
  }
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid json')
}

async function handleProbe(req: http.IncomingMessage, res: http.ServerResponse) {
  const {url} = await readJson(req)
  if (typeof url !== 'string' || !isProbablyUrl(url.trim())) {
    throw new HttpError(400, 'That doesn’t look like a link — paste a full URL.')
  }
  let result
  try {
    result = await probe(await getYtDlp(), url.trim())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`✗ ${url.trim()}: ${message}`)
    throw new HttpError(422, message)
  }
  const {info, infoJsonPath} = result
  const entry: Probe = {
    id: randomUUID(),
    url: url.trim(),
    info,
    infoJsonPath,
    choices: isPlaylist(info) ? buildPlaylistChoices(info) : buildChoices(info),
    createdAt: Date.now(),
  }
  probes.set(entry.id, entry)
  sendJson(res, 200, probeView(entry))
}

async function handleDownload(req: http.IncomingMessage, res: http.ServerResponse) {
  const {probeId, choice: index} = await readJson(req)
  const entry = typeof probeId === 'string' ? probes.get(probeId) : undefined
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
  jobs.set(job.id, job)
  void runJob(job, entry, choice)
  sendJson(res, 200, {jobId: job.id})
}

function handleEvents(job: Job, res: http.ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  for (const event of [...job.history, ...(job.lastProgress ? [job.lastProgress] : [])]) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  if (job.finished) {
    res.end()
    return
  }
  job.listeners.add(res)
  res.on('close', () => job.listeners.delete(res))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))

async function serveStatic(pathname: string, res: http.ServerResponse) {
  const relative = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(WEB_DIR, relative)
  if (!file.startsWith(WEB_DIR)) throw new HttpError(404, 'not found')
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html')
  } catch {
    file = path.join(WEB_DIR, 'index.html') // single-page app
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

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  checkRequest(req)
  const {pathname} = new URL(req.url ?? '/', 'http://localhost')

  if (pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, settingsView())
  if (pathname === '/api/choose-folder' && req.method === 'POST') {
    await readJson(req)
    // opens the OS folder dialog on this machine; resolves when it's closed
    const picked = await osHooks.chooseFolder(outDir)
    if (picked) {
      outDir = picked
      await saveStored({outDir: picked})
    }
    return sendJson(res, 200, settingsView())
  }
  if (pathname === '/api/components' && req.method === 'GET') return sendJson(res, 200, await componentsView())
  if (pathname === '/api/components/check' && req.method === 'POST') {
    await readJson(req)
    try {
      await checkLatest()
    } catch (error) {
      yt.error = error instanceof Error ? error.message : String(error)
    }
    return sendJson(res, 200, await componentsView())
  }
  if (pathname === '/api/components/update' && req.method === 'POST') {
    await readJson(req)
    await updateYtDlp()
    return sendJson(res, 200, await componentsView())
  }
  if (pathname === '/api/components/auto-update' && req.method === 'POST') {
    const {enabled} = await readJson(req)
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'expected {enabled: boolean}')
    yt.autoUpdate = enabled
    await saveStored({autoUpdate: enabled})
    if (enabled) void autoUpdateTick()
    return sendJson(res, 200, await componentsView())
  }
  if (pathname === '/api/probe' && req.method === 'POST') return handleProbe(req, res)
  if (pathname === '/api/download' && req.method === 'POST') return handleDownload(req, res)

  const jobMatch = /^\/api\/jobs\/([\w-]+)(\/events|\/reveal)?$/.exec(pathname)
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]!)
    // finished jobs clean up after themselves, so a late cancel is already done
    if (!job && req.method === 'DELETE' && !jobMatch[2]) {
      res.writeHead(204).end()
      return
    }
    if (!job) throw new HttpError(404, 'This download is gone — start it again.')
    if (req.method === 'DELETE' && !jobMatch[2]) {
      dropJob(job)
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && jobMatch[2] === '/events') return handleEvents(job, res)
    if (req.method === 'POST' && jobMatch[2] === '/reveal') {
      await readJson(req)
      if (!job.result) throw new HttpError(409, 'not finished yet')
      osHooks.reveal(job.result.path, job.result.isFolder)
      res.writeHead(204).end()
      return
    }
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed')
  return serveStatic(pathname, res)
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, {stdio: 'ignore', detached: true}).on('error', () => {}).unref()
}

export async function startWebServer({
  port = DEFAULT_PORT,
  open = true,
  outDir: requestedOutDir,
  preferManagedYtDlp = false,
  desktop: hooks,
}: {
  /** 0 picks any free port. */
  port?: number
  open?: boolean
  outDir?: string
  /** Desktop app: always use (and keep updating) yoinks' own yt-dlp. */
  preferManagedYtDlp?: boolean
  desktop?: Partial<Desktop>
} = {}): Promise<string> {
  const stored = await loadStored()
  const savedOutDir = stored.outDir && (await fs.stat(stored.outDir).catch(() => undefined))?.isDirectory()
  // -o wins for this run; otherwise the folder picked last time, else ~/Downloads
  outDir = requestedOutDir ?? (savedOutDir ? stored.outDir! : outDir)
  osHooks = {...osHooks, canChooseFolder: await desktop.folderPickerAvailable(), ...hooks}
  yt.managed = preferManagedYtDlp || stored.managedYtDlp === true
  yt.autoUpdate = stored.autoUpdate ?? true
  yt.latest = stored.latest
  yt.checkedAt = stored.lastCheck
  // warm up (and on a first run, download) yt-dlp before the first paste
  void getYtDlp()
    .then(() => autoUpdateTick())
    .catch(() => {})

  const server = http.createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      if (res.headersSent) res.end()
      else sendJson(res, status, {error: message})
    })
  })

  // the preferred port may be taken (a second yoinks, another app) — walk up
  let bound = port
  for (;; bound++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        // loopback only: this server runs yt-dlp and writes files
        server.listen(bound, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      break
    } catch (error) {
      if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || bound >= port + 20) throw error
    }
  }
  if (port === 0) bound = (server.address() as {port: number}).port

  setInterval(sweep, 5 * 60 * 1000).unref()
  setInterval(() => void autoUpdateTick(), 6 * 60 * 60 * 1000).unref()
  const cleanup = () => {
    for (const job of jobs.values()) job.controller.abort()
  }
  process.once('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })

  const url = `http://localhost:${bound}`
  if (open) openBrowser(url)
  return url
}
