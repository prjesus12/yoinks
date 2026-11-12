import fs from 'node:fs/promises'
import path from 'node:path'
import {isThemeMode, type ThemeMode} from '../theme.js'
import type {Preset} from './args.js'
import {stateDir} from './state-dir.js'

/**
 * `~/.config/yoinks/config.json` — the settings that are worth keeping between
 * runs without a flag on every command.
 *
 * A convenience, not a trap: a broken or misspelled file is an error that names
 * the problem, because a key that silently does nothing is how config files
 * waste an afternoon.
 */
export type Config = {
  /** Where downloads go, as typed — the caller expands `~`. */
  outDir?: string
  /** yt-dlp's own output template, so it can use any field yt-dlp knows. */
  template?: string
  theme?: ThemeMode
  preset?: Preset
}

const KEYS = ['outDir', 'template', 'theme', 'preset'] as const
const PRESETS: Preset[] = ['mp3', 'm4a', 'best']

/** Without this, yt-dlp writes files with no extension at all. */
export const TEMPLATE_NEEDS_EXT = '%(ext)s'

export function assertTemplate(template: string, source: string): void {
  if (!template.includes(TEMPLATE_NEEDS_EXT)) {
    throw new Error(`${source} needs ${TEMPLATE_NEEDS_EXT} in it — otherwise the files land with no extension`)
  }
}

export async function loadConfig(
  file = path.join(stateDir(), 'config.json'),
  // a file the user named explicitly must exist: silently ignoring it is the
  // same trap as a misspelled key
  {mustExist = false}: {mustExist?: boolean} = {},
): Promise<Config> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    if (mustExist) throw new Error(`${file} does not exist`)
    // no config file is a perfectly good way to run
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${file} is not valid JSON — fix it or delete it`)
  }
  return validate(parsed, file)
}

function validate(value: unknown, file: string): Config {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} should hold an object, like {"template": "%(title)s.%(ext)s"}`)
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !(KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `${file}: unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.join(', ')} — known keys are ${KEYS.join(', ')}`,
    )
  }

  const config: Config = {}
  if (record.outDir !== undefined) {
    if (typeof record.outDir !== 'string' || !record.outDir.trim())
      throw new Error(`${file}: outDir should be a folder`)
    config.outDir = record.outDir
  }
  if (record.template !== undefined) {
    if (typeof record.template !== 'string' || !record.template.trim()) {
      throw new Error(`${file}: template should be a yt-dlp output template`)
    }
    assertTemplate(record.template, `${file}: template`)
    config.template = record.template
  }
  if (record.theme !== undefined) {
    if (typeof record.theme !== 'string' || !isThemeMode(record.theme)) {
      throw new Error(`${file}: theme should be auto, light or dark`)
    }
    config.theme = record.theme
  }
  if (record.preset !== undefined) {
    if (typeof record.preset !== 'string' || !PRESETS.includes(record.preset as Preset)) {
      throw new Error(`${file}: preset should be mp3, m4a or best`)
    }
    config.preset = record.preset as Preset
  }
  return config
}

export type CliFlags = {
  outDir?: string
  template?: string
  themeMode?: ThemeMode
  preset?: Preset
}

export type ResolvedOptions = {
  outDir?: string
  template?: string
  themeMode: ThemeMode
  preset?: Preset
}

/** The precedence this project uses everywhere: flags > config file > defaults. */
export function resolveOptions(flags: CliFlags, config: Config): ResolvedOptions {
  return {
    outDir: flags.outDir ?? config.outDir,
    template: flags.template ?? config.template,
    themeMode: flags.themeMode ?? config.theme ?? 'auto',
    preset: flags.preset ?? config.preset,
  }
}
