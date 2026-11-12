export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * `/Users/you/Downloads/a.mp4` → `~/Downloads/a.mp4`. The one copy of this rule.
 *
 * The separator is checked explicitly: a plain prefix test would turn
 * `/Users/youelsewhere/a.mp4` into `~elsewhere/a.mp4`, and this module is also
 * bundled for the browser, so it cannot import `node:path` to do it properly.
 */
export function tildePath(filepath: string, homedir: string): string {
  // `HOME` can arrive with a trailing separator, and then nothing ever matches
  const home = homedir.length > 1 ? homedir.replace(/[\\/]+$/, '') : homedir
  if (filepath === home) return '~'
  const inside = filepath.startsWith(`${home}/`) || filepath.startsWith(`${home}\\`)
  return inside ? `~${filepath.slice(home.length)}` : filepath
}

export function shortenPath(filepath: string, homedir: string, max = 60): string {
  const pretty = tildePath(filepath, homedir)
  if (pretty.length <= max) return pretty
  const ext = /\.\w{1,5}$/.exec(pretty)?.[0] ?? ''
  return `${pretty.slice(0, max - ext.length - 1)}…${ext}`
}

/**
 * Word-wrap into left-flush lines. Ink's own wrapping keeps the space at
 * each break (wrap-ansi with trim: false), which indents every continuation
 * line by one cell and makes multi-line text look off-center.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  return formatDuration(seconds)
}
