/**
 * Everything one running server owns. Nothing here lives at module scope: two
 * servers in the same process keep their own maps, limits, folders and yt-dlp.
 *
 * The one thing that is deliberately shared is `EXTRA_ARGS` in `lib/ytdlp.ts`
 * (cookies and proxy for every yt-dlp launch) — that belongs to the process.
 */

import {createRequire} from 'node:module'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import type {DownloadChoice, VideoInfo} from '../lib/ytdlp.js'
import * as desktop from './desktop.js'
import {HOSTED_DEFAULTS} from './defaults.js'
import {createRateLimiter, type RateLimiter} from './limits.js'
import type {JobEvent} from './types.js'

export const MINUTE = 60 * 1000

/** Wrong passwords one visitor may try per minute before the server stops answering. */
export const AUTH_FAILURES = 10

export type HostedOptions = {
  /** When set, every request needs this password (HTTP basic auth, any username). */
  password?: string
  /** Downloads running at once, across all visitors. */
  maxJobs: number
  /** Finished files are deleted after this long. */
  fileTtlMs: number
  /** Longest playlist offered. */
  maxPlaylist: number
  /** Cookies to start with, if none were uploaded yet. */
  cookiesFile?: string
  /** Probes one visitor may start per minute. */
  probeLimit?: number
  /** Downloads one visitor may start per minute. */
  downloadLimit?: number
  /** Probes running at once, across all visitors. */
  maxProbes?: number
  /** Trust `x-forwarded-for` — only behind a proxy you control. */
  trustProxy?: boolean
}

/** HostedOptions with every limit filled in — resolved once, read everywhere. */
export type ResolvedHosted = HostedOptions & {
  probeLimit: number
  downloadLimit: number
  maxProbes: number
  trustProxy: boolean
}

export const resolveHosted = (options: HostedOptions): ResolvedHosted => ({...HOSTED_DEFAULTS, ...options})

/** OS integration — the desktop app swaps in Electron's native versions. */
export type Desktop = {
  chooseFolder: (current: string) => Promise<string | undefined>
  reveal: (target: string, isFolder: boolean) => void
  revealLabel: string
  canChooseFolder: boolean
}

export type Probe = {
  id: string
  url: string
  info: VideoInfo
  infoJsonPath: string
  choices: DownloadChoice[]
  createdAt: number
}

export type Job = {
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
  /** Hosted mode: the job's private scratch folder, deleted with the job. */
  dir?: string
  finished: boolean
  createdAt: number
}

/** Hosted: YouTube cookies, uploaded from the page and kept on disk (0600). */
export type Cookies = {updatedAt?: number}

/** yt-dlp: found once per server, shared by its probes and downloads. */
export type YtDlpState = {
  path?: string
  /** Resolved (or being resolved) binary — one first-run download per server. */
  ready?: Promise<string>
  /** Use yoinks' own copy even when the system has one (the desktop app does). */
  managed: boolean
  busy: boolean
  error?: string
  latest?: string
  checkedAt?: number
  autoUpdate: boolean
  /** Given a binary by the caller (tests, embedders) — never replace it. */
  pinned: boolean
}

export type ServerState = {
  probes: Map<string, Probe>
  jobs: Map<string, Job>
  /** Where downloads land — like the terminal UI, straight onto disk. */
  outDir: string
  /** The yt-dlp output template, when one was configured. */
  template?: string
  /** Public-hosting mode: files go to the visitor's browser, not to this disk. */
  hosted?: ResolvedHosted
  osHooks: Desktop
  cookies: Cookies
  yt: YtDlpState
  /** Hosted only: how often one visitor may make the server spawn yt-dlp. */
  probeLimiter: RateLimiter
  downloadLimiter: RateLimiter
  /** Failed password attempts per visitor — a guessing loop is cheap otherwise. */
  authLimiter: RateLimiter
  /** Probes running right now — every one of them is a child process. */
  activeProbes: number
  /** Where the built web app lives, always with a trailing separator. */
  webDir: string
  appVersion: string
}

/** Where the built web app lives. Resolved from the bundle, overridable for tests. */
export const DEFAULT_WEB_DIR = asWebDir(fileURLToPath(new URL('./web/', import.meta.url)))

/**
 * Trailing separator matters: the containment check in `serveStatic` is a
 * prefix test.
 */
export function asWebDir(dir: string): string {
  return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`
}

const readAppVersion = (): string => {
  try {
    return (createRequire(import.meta.url)('../package.json') as {version: string}).version
  } catch {
    // running from source
    return 'dev'
  }
}

/** Read once — the app version is the same for every server in this process. */
export const APP_VERSION = readAppVersion()

/** A fresh, unconfigured server state. No I/O, no side effects. */
export function createServerState(): ServerState {
  return {
    probes: new Map(),
    jobs: new Map(),
    outDir: path.join(os.homedir(), 'Downloads'),
    hosted: undefined,
    osHooks: {
      chooseFolder: desktop.chooseFolder,
      reveal: desktop.reveal,
      revealLabel: desktop.revealLabel(),
      canChooseFolder: false,
    },
    cookies: {updatedAt: undefined},
    yt: {
      path: undefined,
      ready: undefined,
      managed: false,
      busy: false,
      error: undefined,
      latest: undefined,
      checkedAt: undefined,
      autoUpdate: true,
      pinned: false,
    },
    probeLimiter: createRateLimiter({limit: HOSTED_DEFAULTS.probeLimit, windowMs: MINUTE}),
    downloadLimiter: createRateLimiter({limit: HOSTED_DEFAULTS.downloadLimit, windowMs: MINUTE}),
    authLimiter: createRateLimiter({limit: AUTH_FAILURES, windowMs: MINUTE}),
    activeProbes: 0,
    webDir: DEFAULT_WEB_DIR,
    appVersion: APP_VERSION,
  }
}
