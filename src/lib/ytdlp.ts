import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  if (await commandWorks(local, ['--version'])) return local

  onStatus('first run: fetching yt-dlp…')
  await fs.mkdir(YOINKS_DIR, {recursive: true})

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
  const response = await fetch(url, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }

  const tmp = `${local}.download`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, local)
  return local
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

export type VideoInfo = {
  _type?: string
  title: string
  uploader?: string
  channel?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
  playlist_count?: number
  /** Playlists only — with --flat-playlist these are lightweight stubs. */
  entries?: Array<{title?: string; duration?: number; uploader?: string; channel?: string} | null>
}

export function isPlaylist(info: VideoInfo): boolean {
  return info._type === 'playlist' && (info.entries?.length ?? 0) > 0
}

export function playlistSize(info: VideoInfo): number {
  return info.entries?.length ?? info.playlist_count ?? 0
}

// YouTube Music's auto-generated artist channels are "<artist> - Topic"
const cleanArtist = (name?: string | null) => name?.replace(/\s+-\s+Topic$/i, '').trim() || undefined

/**
 * Treat a playlist as an album: the album is the playlist's title, the
 * artist the channel behind most of the tracks (album playlists have no
 * owner), falling back to whoever owns the playlist.
 */
export function playlistAlbum(info: VideoInfo): {artist?: string; album: string} {
  const album = (info.title ?? '').replace(/^Album\s+-\s+/i, '').trim()

  const counts = new Map<string, number>()
  for (const entry of info.entries ?? []) {
    const artist = cleanArtist(entry?.channel ?? entry?.uploader)
    if (artist) counts.set(artist, (counts.get(artist) ?? 0) + 1)
  }
  const [top, topCount = 0] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? []
  const owner = cleanArtist(info.uploader ?? info.channel)?.replace(/^by\s+/i, '')
  // a mixed playlist has no single artist — credit its owner instead
  const artist = top && topCount > playlistSize(info) / 2 ? top : owner
  return {artist, album}
}

/** "<artist> - <album>" for a playlist's download folder. */
export function playlistFolderName(info: VideoInfo): string {
  const {artist, album} = playlistAlbum(info)
  const name = artist && album && artist !== album ? `${artist} - ${album}` : album || artist || 'playlist'
  return sanitizeFilename(name)
}

function sanitizeFilename(name: string): string {
  return (
    name
      // path separators and characters Windows / macOS Finder refuse
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 100)
      .trim() || 'playlist'
  )
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    // --flat-playlist lists a playlist's entries without extracting every
    // video (seconds instead of minutes); single videos are unaffected
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--flat-playlist', '--no-warnings', url], {signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type AudioFormat = 'mp3' | 'm4a'
export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a']

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  format: 'mp4' | AudioFormat
  args: string[]
  /** Download every entry of the playlist into this folder (inside outDir). */
  playlistFolder?: string
}

// square cover art: crop the (usually 16:9) thumbnail to its centered square —
// YouTube Music tracks letterbox the album art, so this recovers it exactly
const SQUARE_COVER = `ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"`

// a bracketed group made only of these words is video noise, not part of the
// song's name: "(Official Video)", "[4K Remaster]", "(Video Oficial)", "(Letra)"
const NOISE_WORD =
  '(?:official|oficial|officiel|music|musical|lyrics?|letra|video|vídeo|videoclip|clip|audio|visuali[sz]er|mv|hd|hq|4k|remaster(?:ed)?|full|in|con)'
/** Python regex (yt-dlp runs it) — a bare "(Remastered)" is the song's own version, so it stays. */
export const TITLE_NOISE = `(?i)\\s*[\\(\\[](?!\\s*remaster(?:ed)?\\s*[\\)\\]])\\s*${NOISE_WORD}(?:\\s+${NOISE_WORD})*\\s*[\\)\\]]`

// --parse-metadata reads a bare word as a field name and splits on ":" —
// the empty %(id&|)s prefix makes the rest a literal template
const literal = (value: string) => `%(id&|)s${value.replaceAll('%', '%%').replaceAll(':', '\\:')}`

/**
 * Music-friendly titles, for the file name and the title tag: drop the
 * video noise, then a leading "<artist> - " when it repeats the artist.
 * Titles that don't match are left alone.
 */
export function cleanTitleArgs(albumArtist?: string): string[] {
  const args = ['--replace-in-metadata', 'title', TITLE_NOISE, '']
  const artists = [...(albumArtist ? [literal(albumArtist)] : []), '%(artist,creator,channel,uploader)s']
  for (const artist of artists) {
    // the artist and the title are joined by a newline, which neither contains;
    // the backreference only matches when the title starts with that artist
    args.push(
      '--parse-metadata',
      `${artist}\n%(title)s:(?i)^(?P<yoinks_artist>[^\n]+)\n(?P=yoinks_artist)\\s+[-–—]\\s+(?P<title>.+)$`,
    )
  }
  return args
}

function audioArgs(format: AudioFormat, albumArtist?: string): string[] {
  return [
    // m4a is YouTube's own AAC stream, so it's kept as-is instead of re-encoded
    ...(format === 'm4a' ? ['-f', 'ba[ext=m4a]/ba/b'] : ['-f', 'ba/b']),
    '-x',
    '--audio-format',
    format,
    '--audio-quality',
    '0',
    '--embed-thumbnail',
    '--convert-thumbnails',
    'jpg',
    '--ppa',
    SQUARE_COVER,
    '--embed-metadata',
    ...cleanTitleArgs(albumArtist),
  ]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const byBitrate = (a: RawFormat, b: RawFormat) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)
  const bestAudio = [...audioOnly].sort(byBitrate)[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx
  const bestM4a = audioOnly.filter(f => f.ext === 'm4a').sort(byBitrate)[0]
  const m4aSize = bestM4a?.filesize ?? bestM4a?.filesize_approx ?? audioSize

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      format: 'mp4',
      label: `${height}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      format: 'mp4',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const sizeLabel = (size?: number) => (size ? ` · ~${formatBytes(size)}` : '')
  choices.push(
    {kind: 'audio', format: 'mp3', label: `audio only · mp3${sizeLabel(audioSize)}`, args: audioArgs('mp3')},
    {kind: 'audio', format: 'm4a', label: `audio only · m4a${sizeLabel(m4aSize)}`, args: audioArgs('m4a')},
  )

  return choices
}

/**
 * Tag every track as part of the same album (album, album artist, track
 * number), so music players group the folder as one record.
 */
export function albumTagArgs({artist, album}: {artist?: string; album: string}): string[] {
  const args = ['--parse-metadata', 'playlist_index:%(meta_track)s']
  if (album) args.push('--parse-metadata', `${literal(album)}:%(meta_album)s`)
  if (artist) args.push('--parse-metadata', `${literal(artist)}:%(meta_album_artist)s`)
  return args
}

export function buildPlaylistChoices(info: VideoInfo): DownloadChoice[] {
  const count = playlistSize(info)
  const playlistFolder = playlistFolderName(info)
  const album = playlistAlbum(info)
  return [
    ...AUDIO_FORMATS.map(
      (format): DownloadChoice => ({
        kind: 'audio',
        format,
        playlistFolder,
        label: `all ${count} tracks · ${format}`,
        args: [...audioArgs(format, album.artist), ...albumTagArgs(album)],
      }),
    ),
    {
      kind: 'video',
      format: 'mp4',
      playlistFolder,
      label: `all ${count} videos · mp4`,
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    },
  ]
}

/** The choice a --mp3 / --m4a / --best flag stands for. */
export function presetChoiceIndex(choices: DownloadChoice[], preset: AudioFormat | 'best'): number {
  // video choices are listed best-first
  return preset === 'best' ? choices.findIndex(c => c.kind === 'video') : choices.findIndex(c => c.format === preset)
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
  /** Playlists only: a new entry started (1-based). */
  onItem?: (item: number, totalItems: number) => void
}

export type DownloadResult = {
  /** The file — or, for playlists, the folder the files were saved into. */
  filepath: string
  /** Files saved (1 for single downloads). */
  count: number
  /** Playlist entries that couldn't be downloaded (private, removed, …). */
  failed: number
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const {playlistFolder} = opts.choice
  const playlist = playlistFolder !== undefined
  const args = [
    ...(opts.infoJsonPath && !playlist ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    // one unavailable video shouldn't sink the whole playlist
    ...(playlist ? ['--yes-playlist', '--ignore-errors'] : ['--no-playlist']),
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    playlist
      ? // the folder is literal text inside yt-dlp's template, so escape its %
        path.join(opts.outDir.replaceAll('%', '%%'), playlistFolder.replaceAll('%', '%%'), '%(playlist_index)02d - %(title).60s.%(ext)s')
      : path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    const filepaths: string[] = []
    let totalItems = 0
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes for the current item, so a cancel can clean
    // up after itself without touching playlist tracks that already finished
    let destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (/^\[download\] Downloading item \d+ of \d+$/.test(line)) {
          const [item, total] = line.match(/\d+/g)!.map(Number) as [number, number]
          totalItems = total
          part = 0
          totalParts = 1
          lastDownloaded = 0
          destinations = []
          handlers.onItem?.(item, total)
        } else if (line.startsWith('[info] Writing video thumbnail ')) {
          const thumbnail = / to: (.+)$/.exec(line)?.[1]
          if (thumbnail) destinations.push(thumbnail, thumbnail.replace(/\.[^./]+$/, '.jpg'))
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepaths.push(line)
          destinations = []
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        void removePartials(destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      const filepath = filepaths.at(-1)
      if (playlist && filepath) {
        // --ignore-errors exits non-zero when any entry failed — still a win
        resolve({
          filepath: path.dirname(filepath),
          count: filepaths.length,
          failed: Math.max(0, totalItems - filepaths.length),
        })
      } else if (code === 0 && filepath) {
        resolve({filepath, count: 1, failed: 0})
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
