// shared by the local server and the web app — type-only, no runtime code

export type ChoiceView = {
  index: number
  kind: 'video' | 'audio'
  format: 'mp4' | 'mp3' | 'm4a'
  /** "MP3", "1080p", … */
  name: string
  detail: string
  size?: string
}

export type Settings = {
  /** Where downloads are saved, "~"-shortened. */
  outDir: string
  /** Whether the server can show a native folder dialog. */
  canChooseFolder: boolean
  /** "Show in Finder", "Show in Explorer", … */
  revealLabel: string
  /** A public server: files are handed to the browser, nothing is saved on disk. */
  hosted: boolean
  /** Hosted: YouTube cookies for yt-dlp, uploadable from the page. */
  cookies?: {
    set: boolean
    updatedAt?: number
    /** Only with a password set — otherwise anyone could swap them. */
    canEdit: boolean
  }
}

export type ProbeView = {
  id: string
  kind: 'video' | 'playlist'
  title: string
  author?: string
  platform: string
  duration?: number
  thumbnail?: string
  /** Playlists: how many entries. */
  count?: number
  /** Playlists: the "Artist - Album" folder the files belong in. */
  folder?: string
  /** A video opened from inside a playlist: the link to the whole thing. */
  playlistUrl?: string
  choices: ChoiceView[]
}

export type JobEvent =
  | {
      type: 'progress'
      downloaded: number
      total?: number
      speed?: number
      eta?: number
      part: number
      parts: number
    }
  | {type: 'processing'}
  | {type: 'refreshing'}
  | {type: 'item'; item: number; total: number}
  | {type: 'file'; index: number; name: string}
  | {type: 'done'; count: number; failed: number; path: string}
  | {type: 'error'; message: string}

/** The tools yoinks runs on, for the settings panel. */
export type ComponentsView = {
  appVersion: string
  ytdlp: {
    version?: string
    /** Newest release on GitHub, once checked. */
    latest?: string
    /** yoinks' own copy (updatable here) vs. one installed on the system. */
    managed: boolean
    /** Installing or updating right now. */
    busy: boolean
    error?: string
    checkedAt?: number
  }
  ffmpeg: {version?: string; source: 'system' | 'bundled' | 'missing'}
  autoUpdate: boolean
}
