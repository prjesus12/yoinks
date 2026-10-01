import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {commandOutput, resolveFfmpeg} from '../lib/ytdlp.js'
export {isNewer} from '../lib/version.js'
import type {ComponentsView} from './types.js'

const SETTINGS_FILE = path.join(os.homedir(), '.config', 'yoinks', 'web.json')
const LATEST_RELEASE = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'

/** What the web UI / desktop app remembers between runs. */
export type StoredSettings = {
  outDir?: string
  /** Keep yoinks' own yt-dlp current without asking. */
  autoUpdate?: boolean
  /** Use yoinks' own yt-dlp even when the system has one. */
  managedYtDlp?: boolean
  lastCheck?: number
  latest?: string
}

export async function loadStored(): Promise<StoredSettings> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as StoredSettings) : {}
  } catch {
    return {}
  }
}

export async function saveStored(patch: Partial<StoredSettings>): Promise<StoredSettings> {
  const next = {...(await loadStored()), ...patch}
  try {
    await fs.mkdir(path.dirname(SETTINGS_FILE), {recursive: true})
    await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // remembering is a nicety
  }
  return next
}

export async function ytDlpVersion(bin: string): Promise<string | undefined> {
  return (await commandOutput(bin, ['--version']))?.trim() || undefined
}

export async function latestYtDlpVersion(signal?: AbortSignal): Promise<string> {
  const res = await fetch(LATEST_RELEASE, {signal, headers: {accept: 'application/vnd.github+json'}})
  if (!res.ok) throw new Error(`Couldn’t check for updates (GitHub said ${res.status}).`)
  const {tag_name: tag} = (await res.json()) as {tag_name?: string}
  if (!tag) throw new Error('Couldn’t read the latest yt-dlp version.')
  return tag
}

export async function ffmpegView(): Promise<ComponentsView['ffmpeg']> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return {source: 'missing'}
  // "ffmpeg version 7.0.2 Copyright …" / "ffmpeg version n7.1-…"
  const firstLine = (await commandOutput(ffmpeg.path, ['-version']))?.split('\n')[0] ?? ''
  const version = /ffmpeg version (\S+)/.exec(firstLine)?.[1]?.replace(/^n/, '').split('-')[0]
  return {source: ffmpeg.source, version}
}
