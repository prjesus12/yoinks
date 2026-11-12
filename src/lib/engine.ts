import {
  buildChoices,
  buildPlaylistChoices,
  download,
  isPlaylist,
  type DownloadChoice,
  type DownloadHandlers,
  type DownloadOptions,
  type DownloadResult,
  type VideoInfo,
} from './ytdlp.js'

/**
 * The download policy both Node surfaces share: the terminal UI and the web
 * server's job runner. It lives here once so the two cannot drift.
 *
 * The browser UI (`web/src/App.tsx`) gets the same policy indirectly — it
 * starts a job through `/api/*` and the server runs it — and `expo/` is a
 * separate published package with its own types. Neither imports this module
 * directly: it pulls in `ytdlp.ts`, which is `node:*` all the way down, so it
 * cannot be bundled for a browser.
 */

/** The picker's options for a probed link: the playlist's entries, or the video's formats. */
export function choicesFor(info: VideoInfo): DownloadChoice[] {
  return isPlaylist(info) ? buildPlaylistChoices(info) : buildChoices(info)
}

export type FreshInfoPolicy = {
  signal?: AbortSignal
  /** Called once, between the cached attempt and the fresh one. */
  onRefresh?: () => void
  /** A playlist always extracts fresh, so there is nothing stale to retry. */
  playlist: boolean
}

/**
 * Run an attempt that reuses the probe's metadata, and try once more without it
 * if that fails. Media urls in the cached info expire, so the first failure is
 * usually stale metadata rather than a real error.
 *
 * Two failures, a cancel, or a playlist end it: a cancel is the user asking to
 * stop, and a playlist never had cached metadata to go stale.
 */
export async function withFreshInfo<T>(
  attempt: (useCachedInfo: boolean) => Promise<T>,
  {signal, onRefresh, playlist}: FreshInfoPolicy,
): Promise<T> {
  try {
    return await attempt(true)
  } catch (error) {
    if (signal?.aborted || playlist) throw error
    onRefresh?.()
    return attempt(false)
  }
}

export function downloadWithFreshInfo(
  opts: DownloadOptions,
  handlers: DownloadHandlers,
  // required on purpose: a caller that forgets the signal would retry a cancel
  policy: Omit<FreshInfoPolicy, 'playlist'>,
): Promise<DownloadResult> {
  return withFreshInfo(
    useCachedInfo => download(useCachedInfo ? opts : {...opts, infoJsonPath: undefined}, handlers, policy.signal),
    {...policy, playlist: opts.choice.playlistFolder !== undefined},
  )
}
