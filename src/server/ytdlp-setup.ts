// The tools one server runs on: the yt-dlp binary (found, checked, replaced) and the YouTube cookies it uses.

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {EXTRA_ARGS, ensureYtDlp, installManagedYtDlp, MANAGED_YTDLP} from '../lib/ytdlp.js'
import {stateDir} from '../lib/state-dir.js'
import {ffmpegView, isNewer, latestYtDlpVersion, saveStored, ytDlpVersion} from './components.js'
import {HttpError, checkPassword, readJson, sendJson} from './security.js'
import type {ServerState} from './state.js'
import type {ComponentsView} from './types.js'
import {settingsView} from './views.js'

const MAX_COOKIES = 512 * 1024
const cookiesFile = () => path.join(stateDir(), 'cookies.txt')
const DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// hosted: YouTube cookies, uploaded from the page and kept on disk (0600)

function useCookies(file: string | undefined) {
  const at = EXTRA_ARGS.indexOf('--cookies')
  if (at >= 0) EXTRA_ARGS.splice(at, 2)
  if (file) EXTRA_ARGS.push('--cookies', file)
}

export async function loadCookies(state: ServerState, seed?: string) {
  let stat = await fs.stat(cookiesFile()).catch(() => undefined)
  if (!stat && seed) {
    await fs.mkdir(path.dirname(cookiesFile()), {recursive: true})
    await fs.copyFile(seed, cookiesFile())
    await fs.chmod(cookiesFile(), 0o600)
    stat = await fs.stat(cookiesFile())
  }
  state.cookies.updatedAt = stat?.mtimeMs
  useCookies(stat ? cookiesFile() : undefined)
}

export async function handleCookies(state: ServerState, req: http.IncomingMessage, res: http.ServerResponse) {
  // the jar belongs to the authenticated operator. The router already checked,
  // but re-checking keeps this handler safe if a future caller forgets to.
  if (!checkPassword(state, req, res)) return
  if (!state.hosted?.password) throw new HttpError(403, 'Set YOINKS_PASSWORD on the server to manage cookies here.')
  if (req.method === 'DELETE') {
    await fs.rm(cookiesFile(), {force: true})
    state.cookies.updatedAt = undefined
    useCookies(undefined)
    return sendJson(res, 200, settingsView(state))
  }
  const {text} = await readJson(req, MAX_COOKIES)
  const looksRight =
    typeof text === 'string' && text.split(/\r?\n/).some(line => !line.startsWith('#') && line.split('\t').length === 7)
  if (!looksRight) {
    throw new HttpError(400, 'That doesn’t look like a cookies.txt file (Netscape format).')
  }
  await fs.mkdir(path.dirname(cookiesFile()), {recursive: true})
  await fs.writeFile(cookiesFile(), text as string, {mode: 0o600})
  await fs.chmod(cookiesFile(), 0o600)
  state.cookies.updatedAt = Date.now()
  useCookies(cookiesFile())
  return sendJson(res, 200, settingsView(state))
}

// ---------------------------------------------------------------------------
// yt-dlp: found once, shared by every probe and download, updatable in place

export function getYtDlp(state: ServerState): Promise<string> {
  const yt = state.yt
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

export async function checkLatest(state: ServerState) {
  const yt = state.yt
  yt.latest = await latestYtDlpVersion()
  yt.checkedAt = Date.now()
  await saveStored({latest: yt.latest, lastCheck: yt.checkedAt})
}

/** Fetch the newest official yt-dlp and switch to it (from a system copy too). */
export async function updateYtDlp(state: ServerState) {
  const yt = state.yt
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

export async function componentsView(state: ServerState): Promise<ComponentsView> {
  const yt = state.yt
  // don't hold the panel hostage to a first-run download
  const bin = yt.path ?? (yt.busy ? undefined : await getYtDlp(state).catch(() => undefined))
  return {
    appVersion: state.appVersion,
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
export async function autoUpdateTick(state: ServerState) {
  const yt = state.yt
  if (!yt.autoUpdate || yt.busy) return
  // a running download holds the binary open (and Windows won't replace it)
  if ([...state.jobs.values()].some(job => !job.finished)) return
  try {
    const bin = await getYtDlp(state)
    if (bin !== MANAGED_YTDLP) return
    if (!yt.latest || Date.now() - (yt.checkedAt ?? 0) > DAY) await checkLatest(state)
    const current = await ytDlpVersion(bin)
    if (yt.latest && current && isNewer(yt.latest, current)) await updateYtDlp(state)
  } catch {
    // offline or rate-limited — try again next tick
  }
}
