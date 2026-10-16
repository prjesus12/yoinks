import {requireOptionalNativeModule} from 'expo'
import {fetch} from 'expo/fetch'
import {Directory, File, Paths} from 'expo-file-system'
import {extract, pickFormats, USER_AGENT, type Format, type PickOptions, type VideoInfo} from './youtube'

// ios/YtdlpModule.swift — absent in Expo Go, so only audio works there
const Native = requireOptionalNativeModule<{mux(video: string, audio: string, output: string, durationMs: number): Promise<void>}>('Ytdlp')

// googlevideo cuts a plain GET off after ~600 KB; yt-dlp asks for 10 MiB
// `range=` slices instead (CHUNK_SIZE in _video.py), and so do we.
const CHUNK = 10 << 20

export type DownloadOptions = PickOptions & {
  /** Where the file lands. Defaults to the app's document directory. */
  directory?: Directory
  onProgress?: (downloaded: number, total?: number) => void
  signal?: AbortSignal
}

/** url (or an extract() result) → .mp4, or .m4a with audioOnly. */
export async function download(target: string | VideoInfo, options: DownloadOptions = {}): Promise<File> {
  const info = typeof target === 'string' ? await extract(target, options.signal) : target
  const {video, audio} = pickFormats(info, options)
  if (video && !Native) throw new Error('Video needs the native Ytdlp module (a dev build, not Expo Go). audioOnly works anywhere.')

  const dir = options.directory ?? Paths.document
  const name = info.title.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || info.id
  const total = (video ? video.filesize ?? NaN : 0) + (audio.filesize ?? NaN)
  let downloaded = 0
  const onBytes = (n: number) => options.onProgress?.((downloaded += n), Number.isNaN(total) ? undefined : total)

  if (!video) {
    const out = new File(dir, `${name}.m4a`)
    await fetchFormat(audio, out, onBytes, options.signal)
    return out
  }

  const parts = [new File(Paths.cache, `${info.id}.video.mp4`), new File(Paths.cache, `${info.id}.audio.m4a`)]
  try {
    await Promise.all([fetchFormat(video, parts[0], onBytes, options.signal), fetchFormat(audio, parts[1], onBytes, options.signal)])
    const out = new File(dir, `${name}.mp4`)
    if (out.exists) out.delete()
    await Native!.mux(parts[0].uri, parts[1].uri, out.uri, audio.durationMs ?? info.duration * 1000)
    return out
  } finally {
    for (const part of parts) if (part.exists) part.delete()
  }
}

async function fetchFormat(format: Format, dest: File, onBytes: (n: number) => void, signal?: AbortSignal) {
  dest.create({overwrite: true, intermediates: true})
  const handle = dest.open()
  try {
    for (let start = 0; ; start += CHUNK) {
      const res = await fetch(`${format.url}&range=${start}-${start + CHUNK - 1}`, {headers: {'user-agent': USER_AGENT}, signal})
      if (!res.ok) throw new Error(`Download failed (${res.status}). The link may have expired — extract again.`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      handle.writeBytes(bytes)
      onBytes(bytes.length)
      if (bytes.length < CHUNK || (format.filesize && start + CHUNK >= format.filesize)) break
    }
  } catch (e) {
    handle.close()
    dest.delete()
    throw e
  }
  handle.close()
}
