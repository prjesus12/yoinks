// Composition and startup: build the state, wire the HTTP server, and shut it all down again.

import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import {loadStored} from './components.js'
import {HOSTED_DEFAULTS} from './defaults.js'
import * as desktop from './desktop.js'
import {jobsRunning, sweep} from './jobs.js'
import {createRateLimiter} from './limits.js'
import {route} from './router.js'
import {HttpError, sendJson} from './security.js'
import {
  asWebDir,
  createServerState,
  MINUTE,
  resolveHosted,
  type Desktop,
  type HostedOptions,
  type ServerState,
} from './state.js'
import {autoUpdateTick, getYtDlp, loadCookies} from './ytdlp-setup.js'

export type {ChoiceView, ComponentsView, JobEvent, ProbeView, Settings} from './types.js'
export type {Desktop, HostedOptions} from './state.js'

/** How long in-flight work gets to clean up before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 5000

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, {stdio: 'ignore', detached: true})
    .on('error', () => {})
    .unref()
}

/**
 * Stop in order: take no new connections, end the open event streams, cancel
 * the downloads, give them a bounded moment to clean up, then leave nothing
 * behind. Exiting on the spot used to kill downloads mid-write and strand
 * probe metadata and scratch folders in /tmp.
 */
async function closeServer(state: ServerState, server: http.Server) {
  const {probes, jobs} = state
  const closed = new Promise<void>(resolve => server.close(() => resolve()))
  server.closeIdleConnections()
  for (const job of jobs.values()) {
    for (const res of [...job.listeners]) res.end()
    job.controller.abort()
  }
  await Promise.race([closed, new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS))])
  server.closeAllConnections()
  await Promise.allSettled([...probes.values()].map(entry => fs.rm(entry.infoJsonPath, {force: true})))
  await Promise.allSettled(
    [...jobs.values()].map(job => (job.dir ? fs.rm(job.dir, {recursive: true, force: true}) : Promise.resolve())),
  )
  probes.clear()
  jobs.clear()
}

/** A running server: where it listens, and how to stop it. */
export type WebServer = {
  url: string
  close: () => Promise<void>
  /** Downloads still running — the desktop app asks before quitting on them. */
  activeDownloads: () => number
}

export async function startWebServer({
  port = HOSTED_DEFAULTS.port,
  open = true,
  outDir: requestedOutDir,
  preferManagedYtDlp = false,
  desktop: hooks,
  hosted: hostedOptions,
  host,
  ytdlpPath,
  webDir: webDirOption,
  template,
}: {
  /** 0 picks any free port. */
  port?: number
  open?: boolean
  outDir?: string
  /** Desktop app: always use (and keep updating) yoinks' own yt-dlp. */
  preferManagedYtDlp?: boolean
  desktop?: Partial<Desktop>
  /** Serve the public: bind to every interface, hand files to the browser. */
  hosted?: HostedOptions
  /** Interface to listen on (hosted defaults to all of them). */
  host?: string
  /** Use this binary instead of discovering one — no first-run download. */
  ytdlpPath?: string
  /** Serve the web app from here instead of the folder next to the bundle. */
  webDir?: string
  /** yt-dlp output template for every download this server runs. */
  template?: string
} = {}): Promise<WebServer> {
  const state = createServerState()
  // per-server, not module-wide: closing one server must never make another
  // server's close() a silent no-op
  let closed = false
  if (webDirOption) state.webDir = asWebDir(webDirOption)
  state.template = template
  state.hosted = hostedOptions ? resolveHosted(hostedOptions) : undefined
  if (state.hosted) {
    state.probeLimiter = createRateLimiter({limit: state.hosted.probeLimit, windowMs: MINUTE})
    state.downloadLimiter = createRateLimiter({limit: state.hosted.downloadLimit, windowMs: MINUTE})
    await loadCookies(state, state.hosted.cookiesFile)
  }
  const stored = await loadStored()
  const savedOutDir = stored.outDir && (await fs.stat(stored.outDir).catch(() => undefined))?.isDirectory()
  // -o wins for this run; otherwise the folder picked last time, else ~/Downloads
  state.outDir = requestedOutDir ?? (savedOutDir ? stored.outDir! : state.outDir)
  state.osHooks = {...state.osHooks, canChooseFolder: await desktop.folderPickerAvailable(), ...hooks}
  const yt = state.yt
  yt.managed = preferManagedYtDlp || stored.managedYtDlp === true
  yt.autoUpdate = stored.autoUpdate ?? true
  yt.latest = stored.latest
  yt.checkedAt = stored.lastCheck
  // warm up (and on a first run, download) yt-dlp before the first paste
  if (ytdlpPath) {
    // tests and embedders hand us a binary — never fetch or replace it
    yt.path = ytdlpPath
    yt.ready = Promise.resolve(ytdlpPath)
    yt.pinned = true
  } else {
    // a fresh state holds no binary yet: resolve one, pinned or not, from here
    yt.pinned = false
    yt.path = undefined
    yt.ready = undefined
    void getYtDlp(state)
      .then(() => autoUpdateTick(state))
      .catch(() => {})
  }

  const server = http.createServer((req, res) => {
    route(state, req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof Error ? error.message : String(error)
      const headers = error instanceof HttpError ? error.headers : {}
      // the visitor may already be gone (closed tab, cancelled probe)
      if (res.writableEnded) return
      if (res.destroyed) return
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, status, {error: message}, headers)
    })
  })

  // the preferred port may be taken (a second yoinks, another app) — walk up
  let bound = port
  for (; ; bound++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        // loopback only: this server runs yt-dlp and writes files
        server.listen(bound, host ?? (state.hosted ? '0.0.0.0' : '127.0.0.1'), () => {
          server.off('error', reject)
          resolve()
        })
      })
      break
    } catch (error) {
      const taken = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      if (state.hosted || port === 0 || !taken || bound >= port + 20) throw error
    }
  }
  if (port === 0) bound = (server.address() as {port: number}).port

  const sweepTimer = setInterval(() => sweep(state), 5 * 60 * 1000).unref()
  const updateTimer = setInterval(() => void autoUpdateTick(state), 6 * 60 * 60 * 1000).unref()

  const close = async () => {
    if (closed) return
    closed = true
    clearInterval(sweepTimer)
    clearInterval(updateTimer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await closeServer(state, server)
  }
  const onSignal = () => void close().then(() => process.exit(0))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // `localhost` resolves to 127.0.0.1, which is not where an IPv6 loopback bind
  // is listening — print something that actually reaches it
  const displayHost = host === '::1' || host === '0:0:0:0:0:0:0:1' ? '[::1]' : 'localhost'
  const url = `http://${displayHost}:${bound}`
  if (open) openBrowser(url)
  return {url, close, activeDownloads: () => jobsRunning(state)}
}
