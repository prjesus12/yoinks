// A port of yt-dlp's YouTube extractor (yt_dlp/extractor/youtube), cut down to
// the one InnerTube client that needs neither a JS runtime nor a PO token:
// `visionos`, yt-dlp's _DEFAULT_JSLESS_CLIENTS. Its stream urls come back plain
// (no signatureCipher, no `n` challenge), so there's nothing to decipher.
//
// When YouTube breaks it, copy INNERTUBE_CLIENTS['visionos'] from yt-dlp's
// yt_dlp/extractor/youtube/_base.py into CLIENT / USER_AGENT below.

const CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
  gl: 'US',
}
const CLIENT_NAME_ID = '101'
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

export type Format = {
  itag: number
  url: string
  kind: 'video' | 'audio'
  /** "avc1.640028", "mp4a.40.2", "opus"… */
  codec: string
  container: 'mp4' | 'webm'
  height?: number
  fps?: number
  bitrate: number
  filesize?: number
  durationMs?: number
  /** Dubbed / descriptive audio tracks are false. */
  defaultAudio: boolean
  /** Dynamic-range-compressed ("stable volume") audio. */
  drc: boolean
}

export type VideoInfo = {
  id: string
  title: string
  author: string
  /** Seconds. */
  duration: number
  thumbnail?: string
  formats: Format[]
}

export function videoId(url: string) {
  if (/^[\w-]{11}$/.test(url)) return url
  const m = /(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live|v)\/)([\w-]{11})/.exec(url)
  if (!m) throw new Error('That doesn’t look like a YouTube video link.')
  return m[1]
}

// Without a visitor id YouTube answers "Sign in to confirm you're not a bot"
// for many videos. yt-dlp gets it from the watch page's ytcfg; so do we, once.
let visitorData: string | undefined
async function getVisitorData(id: string, signal?: AbortSignal) {
  if (visitorData) return visitorData
  const html = await fetch(`https://www.youtube.com/watch?v=${id}`, {signal, headers: {'user-agent': USER_AGENT}}).then(r => r.text())
  visitorData = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1]
  if (!visitorData) throw new Error('Couldn’t read YouTube’s visitor id.')
  return visitorData
}

export async function extract(url: string, signal?: AbortSignal): Promise<VideoInfo> {
  const id = videoId(url)
  const visitor = await getVisitorData(id, signal)
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      origin: 'https://www.youtube.com',
      'x-youtube-client-name': CLIENT_NAME_ID,
      'x-youtube-client-version': CLIENT.clientVersion,
      'x-goog-visitor-id': visitor,
    },
    body: JSON.stringify({
      context: {client: {...CLIENT, visitorData: visitor}},
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {contentPlaybackContext: {html5Preference: 'HTML5_PREF_WANTS'}},
    }),
  })
  if (!res.ok) throw new Error(`YouTube answered ${res.status}.`)
  const data = await res.json()

  const status = data.playabilityStatus
  if (status?.status !== 'OK') {
    // visionos can't see "made for kids" videos; yt-dlp falls back to clients that need a JS runtime
    throw new Error(status?.reason ?? status?.messages?.[0] ?? `YouTube won’t play this (${status?.status}).`)
  }
  const details = data.videoDetails
  if (details.isLive) throw new Error('Live streams aren’t supported.')

  const raw: any[] = [...(data.streamingData?.formats ?? []), ...(data.streamingData?.adaptiveFormats ?? [])]
  const formats = raw.filter(f => f.url).map(toFormat)
  if (!formats.length) throw new Error('YouTube sent no downloadable formats.')

  return {
    id,
    title: details.title,
    author: details.author,
    duration: Number(details.lengthSeconds),
    thumbnail: details.thumbnail?.thumbnails?.at(-1)?.url,
    formats,
  }
}

function toFormat(f: any): Format {
  // 'video/mp4; codecs="avc1.640028"'
  const [, type, container, codec] = /^(\w+)\/(\w+);\s*codecs="([^"]+)"/.exec(f.mimeType) ?? []
  return {
    itag: f.itag,
    url: f.url,
    kind: type === 'audio' ? 'audio' : 'video',
    codec,
    container: container === 'webm' ? 'webm' : 'mp4',
    height: f.height,
    fps: f.fps,
    bitrate: f.bitrate,
    filesize: f.contentLength ? Number(f.contentLength) : undefined,
    durationMs: f.approxDurationMs ? Number(f.approxDurationMs) : undefined,
    defaultAudio: f.audioTrack?.audioIsDefault ?? true,
    drc: !!f.isDrc,
  }
}

export type PickOptions = {
  /** Just the m4a audio. */
  audioOnly?: boolean
  /** Tallest video to take. Default 1080 — H.264 tops out there. */
  maxHeight?: number
}

/**
 * yt-dlp's `-f "bv[vcodec^=avc1]+ba[ext=m4a]"`: H.264 + AAC, the pair iOS can
 * merge into an mp4 without re-encoding (VP9/AV1/Opus can't go there losslessly).
 */
export function pickFormats(info: VideoInfo, {audioOnly, maxHeight = 1080}: PickOptions = {}) {
  const audio = info.formats
    .filter(f => f.kind === 'audio' && f.codec.startsWith('mp4a') && f.defaultAudio && !f.drc)
    .sort((a, b) => b.bitrate - a.bitrate)[0]
  if (!audio) throw new Error('No m4a audio for this video.')
  if (audioOnly) return {audio}

  const video = info.formats
    .filter(f => f.kind === 'video' && f.codec.startsWith('avc1') && (f.height ?? 0) <= maxHeight)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0) || b.bitrate - a.bitrate)[0]
  if (!video) throw new Error(`No H.264 video at ${maxHeight}p or below.`)
  return {video, audio}
}
