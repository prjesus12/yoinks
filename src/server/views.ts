// What the browser gets to see: probe → client shape, the settings view, and "~" path shortening.
// Choices stay server-side — the client only ever sends back an index, never yt-dlp arguments.

import os from 'node:os'
import {
  isPlaylist,
  playlistAlbum,
  playlistFolderName,
  playlistSize,
  type DownloadChoice,
  type VideoInfo,
} from '../lib/ytdlp.js'
import {detectPlatform, playlistUrlFor} from '../lib/platforms.js'
import type {Probe, ServerState} from './state.js'
import type {ChoiceView, ProbeView, Settings} from './types.js'

export const prettyPath = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p)

export const settingsView = (state: ServerState): Settings => ({
  outDir: prettyPath(state.outDir),
  canChooseFolder: state.osHooks.canChooseFolder,
  revealLabel: state.osHooks.revealLabel,
  hosted: Boolean(state.hosted),
  cookies: state.hosted
    ? {
        set: state.cookies.updatedAt !== undefined,
        updatedAt: state.cookies.updatedAt,
        canEdit: Boolean(state.hosted.password),
      }
    : undefined,
})

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
  const name = choice.kind === 'audio' ? choice.format.toUpperCase() : (/^\d+p/.exec(parts[0] ?? '')?.[0] ?? 'Best')
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

export function probeView(probe: Probe): ProbeView {
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
