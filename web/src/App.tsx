import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react'
import {formatBytes, formatDuration, formatEta, formatSpeed} from '../../src/lib/format'
import {
  chooseFolder,
  dropJob,
  fileUrl,
  followJob,
  getComponents,
  getSettings,
  probeUrl,
  revealJob,
  startDownload,
  type ChoiceView,
  type ComponentsView,
  type JobEvent,
  type ProbeView,
  type Settings,
} from './api'
import {ArrowRight, Check, Folder, Music, Settings as SettingsIcon, Spinner, Video, X} from './icons'
import {Logo} from './logo'
import {SettingsDialog, updateAvailable} from './SettingsDialog'
import {eachLimit, splitLinks} from '../../src/lib/links'

// set by the desktop app (?shell=darwin|win32|linux) — styles the title bar
const SHELL = new URLSearchParams(location.search).get('shell') ?? undefined
if (SHELL) document.documentElement.dataset.shell = SHELL

type Progress = Extract<JobEvent, {type: 'progress'}>

/** The link being looked at right now — downloads run on their own below it. */
type State = {step: 'idle'; error?: string} | {step: 'probing'} | {step: 'ready'; probe: ProbeView; error?: string}

/** One download in the list. Several run at once. */
type Download = {
  key: string
  url: string
  status: 'queued' | 'probing' | 'downloading' | 'done' | 'error'
  probe?: ProbeView
  choice?: ChoiceView
  jobId?: string
  progress?: Progress
  processing: boolean
  refreshing: boolean
  item?: {item: number; total: number}
  saved: number
  path?: string
  count?: number
  failed?: number
  error?: string
}

type ActiveDownload = Download & {probe: ProbeView; choice: ChoiceView}

/** Links pasted together are read and downloaded this many at a time. */
const BATCH_CONCURRENCY = 3

const PREFERRED_FORMAT = 'yoinks:format'

function readPreference(): string | undefined {
  try {
    return localStorage.getItem(PREFERRED_FORMAT) ?? undefined
  } catch {
    return undefined
  }
}

function writePreference(choice: ChoiceView) {
  try {
    localStorage.setItem(PREFERRED_FORMAT, choice.kind === 'audio' ? choice.format : 'video')
  } catch {
    // a nicety only
  }
}

/** Last format used, else MP3 — most links pasted here end up as music. */
function defaultChoice(probe: ProbeView): number {
  const preferred = readPreference()
  const match =
    preferred === 'video'
      ? probe.choices.find(c => c.kind === 'video')
      : probe.choices.find(c => c.format === (preferred ?? 'mp3'))
  return (match ?? probe.choices[0])!.index
}

let lastKey = 0
const newDownload = (url: string, status: Download['status']): Download => ({
  key: String(++lastKey),
  url,
  status,
  processing: false,
  refreshing: false,
  saved: 0,
})

export function App() {
  const [url, setUrl] = useState('')
  const [state, setState] = useState<State>({step: 'idle'})
  const [downloads, setDownloads] = useState<Download[]>([])
  const [selected, setSelected] = useState(0)
  const [showAllVideo, setShowAllVideo] = useState(false)
  const [settings, setSettings] = useState<Settings>()
  const [choosing, setChoosing] = useState(false)
  const [components, setComponents] = useState<ComponentsView>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Running downloads: close stops following, cancel also stops the job. */
  const runsRef = useRef(new Map<string, {close: () => void; cancel: () => void}>())
  /** Downloads dismissed while still waiting or reading their link. */
  const dismissedRef = useRef(new Set<string>())

  useEffect(() => {
    inputRef.current?.focus()
    getSettings().then(setSettings, () => {})
    getComponents().then(setComponents, () => {})
    const runs = runsRef.current
    return () => {
      for (const run of runs.values()) run.close()
    }
  }, [])

  // first launch: yt-dlp is still downloading — follow along until it's ready
  const installing = Boolean(components?.ytdlp.busy && !components.ytdlp.version)
  useEffect(() => {
    if (!installing) return
    const timer = setInterval(() => getComponents().then(setComponents, () => {}), 2000)
    return () => clearInterval(timer)
  }, [installing])

  async function onChooseFolder() {
    setChoosing(true)
    try {
      setSettings(await chooseFolder())
    } catch {
      // dialog failed to open — keep the current folder
    } finally {
      setChoosing(false)
    }
  }

  const patch = (key: string, change: Partial<Download>) =>
    setDownloads(prev => prev.map(d => (d.key === key ? {...d, ...change} : d)))

  async function load(target: string) {
    const trimmed = target.trim()
    if (!trimmed) return
    setUrl(trimmed)
    setState({step: 'probing'})
    setShowAllVideo(false)
    try {
      const probe = await probeUrl(trimmed)
      setSelected(defaultChoice(probe))
      setState({step: 'ready', probe})
    } catch (error) {
      setState({step: 'idle', error: (error as Error).message})
    }
  }

  /** Several links at once: each goes straight to the list in the last format used. */
  async function loadMany(links: string[]) {
    const items = links.map(link => newDownload(link, 'queued'))
    setDownloads(prev => [...items, ...prev])
    reset()
    await eachLimit(items, BATCH_CONCURRENCY, item => runItem(item.key, item.url))
  }

  /** Read a link (unless already read) and download it; resolves when it's over. */
  async function runItem(key: string, link: string, probe?: ProbeView, choice?: ChoiceView) {
    if (dismissedRef.current.has(key)) return
    if (!probe) {
      patch(key, {status: 'probing', error: undefined})
      try {
        probe = await probeUrl(link)
      } catch (error) {
        patch(key, {status: 'error', error: (error as Error).message})
        return
      }
      if (dismissedRef.current.has(key)) return
    }
    choice ??= probe.choices.find(c => c.index === defaultChoice(probe!))!
    patch(key, {status: 'probing', probe, choice, error: undefined})
    let jobId: string
    try {
      jobId = await startDownload(probe.id, choice.index)
    } catch (error) {
      patch(key, {status: 'error', error: (error as Error).message})
      return
    }
    if (dismissedRef.current.has(key)) {
      dropJob(jobId)
      return
    }
    await follow(key, probe, choice, jobId)
  }

  /** The server writes the files itself, like the terminal does — the page only follows along. */
  function follow(key: string, probe: ProbeView, choice: ChoiceView, jobId: string): Promise<void> {
    patch(key, {
      status: 'downloading',
      probe,
      choice,
      jobId,
      progress: undefined,
      processing: false,
      refreshing: false,
      item: undefined,
      saved: 0,
      error: undefined,
    })
    return new Promise(resolve => {
      const finish = () => {
        runsRef.current.delete(key)
        resolve()
      }
      const stop = followJob(jobId, event => {
        switch (event.type) {
          case 'progress':
            patch(key, {progress: event, processing: false})
            break
          case 'processing':
            patch(key, {processing: true})
            break
          case 'refreshing':
            patch(key, {refreshing: true, progress: undefined})
            break
          case 'item':
            patch(key, {item: {item: event.item, total: event.total}, progress: undefined, processing: false})
            break
          case 'file':
            patch(key, {saved: event.index + 1})
            break
          case 'done':
            patch(key, {status: 'done', path: event.path, count: event.count, failed: event.failed})
            finish()
            break
          case 'error':
            stop()
            dropJob(jobId)
            patch(key, {status: 'error', error: event.message})
            finish()
            break
        }
      })
      runsRef.current.set(key, {
        close: stop,
        cancel: () => {
          stop()
          dropJob(jobId)
          finish()
        },
      })
    })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    const links = splitLinks(url)
    if (links.length > 1) void loadMany(links)
    else void load(url)
  }

  async function onSave(probe: ProbeView) {
    const choice = probe.choices[selected]!
    writePreference(choice)

    let jobId: string
    try {
      jobId = await startDownload(probe.id, choice.index)
    } catch (error) {
      setState({step: 'ready', probe, error: (error as Error).message})
      return
    }

    // the download moves to the list below — the box is free for the next link
    const item = newDownload(url.trim(), 'downloading')
    setDownloads(prev => [item, ...prev])
    reset()
    void follow(item.key, probe, choice, jobId)
  }

  /** Cancel a running download, or just take a finished one off the list. */
  function dismiss(key: string) {
    dismissedRef.current.add(key)
    runsRef.current.get(key)?.cancel()
    setDownloads(prev => prev.filter(d => d.key !== key))
  }

  function retry(download: Download) {
    void runItem(download.key, download.url, download.probe, download.choice)
  }

  const clearFinished = () => setDownloads(prev => prev.filter(d => d.status !== 'done'))

  function reset() {
    setUrl('')
    setState({step: 'idle'})
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const hosted = Boolean(settings?.hosted)
  // YouTube's bot check — hosted servers fix it with uploaded cookies
  const needsCookies = (message: string) =>
    hosted && Boolean(settings?.cookies?.canEdit) && /confirm you.re not a bot/i.test(message)
  const cookiesLink = (
    <>
      {' '}
      <button type="button" className="link" onClick={() => setSettingsOpen(true)}>
        Add cookies
      </button>
    </>
  )
  const busy = state.step === 'probing'
  const running = downloads.filter(d => d.status !== 'done' && d.status !== 'error').length
  const finished = downloads.filter(d => d.status === 'done').length

  return (
    <div className="shell">
      <header className="header">
        <button type="button" className="brand" onClick={reset} aria-label="yoinks — start over">
          <Logo height={16} />
        </button>
        <div className="header-end">
          {SHELL || hosted ? null : (
            <span className="badge">
              <span className="dot" aria-hidden /> Running on this computer
            </span>
          )}
          {hosted && !settings?.cookies?.canEdit ? null : (
            <button
              type="button"
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
              aria-label={updateAvailable(components) ? 'Settings — update available' : 'Settings'}
              title="Settings"
            >
              <SettingsIcon />
              {updateAvailable(components) ? <span className="update-dot" aria-hidden /> : null}
            </button>
          )}
        </div>
      </header>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChooseFolder={() => void onChooseFolder()}
        choosing={choosing}
        components={components}
        onComponents={setComponents}
        onSettings={setSettings}
      />

      <main className="main">
        <section className="hero">
          <h1>Save video and music from anywhere.</h1>
          <p className="lede">
            {hosted
              ? 'YouTube, X, Instagram, TikTok and 1,800+ sites. Playlists arrive as one zip — an album, with cover art on every track.'
              : 'YouTube, X, Instagram, TikTok and 1,800+ sites. Playlists arrive as albums — a folder per album, with cover art on every track.'}
          </p>
        </section>

        <form className="search" onSubmit={onSubmit}>
          <label htmlFor="url" className="sr-only">
            Link
          </label>
          <input
            id="url"
            ref={inputRef}
            className="search-input"
            // text, not url: several links separated by spaces are welcome too
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a link — or several at once"
            value={url}
            disabled={busy}
            onChange={e => setUrl(e.target.value)}
            onPaste={e => {
              if (url.trim() !== '') return
              // pasting a link is the whole intent — skip the extra click
              const links = splitLinks(e.clipboardData.getData('text'))
              if (links.length === 0) return
              e.preventDefault()
              if (links.length > 1) void loadMany(links)
              else void load(links[0]!)
            }}
          />
          <button className="button primary" type="submit" disabled={busy || !url.trim()}>
            {state.step === 'probing' ? <Spinner /> : 'Continue'}
          </button>
        </form>

        {state.step === 'idle' && state.error ? (
          <p className="alert" role="alert">
            {state.error}
            {needsCookies(state.error) ? cookiesLink : null}
          </p>
        ) : null}
        {installing && (state.step === 'idle' || state.step === 'probing') ? (
          <p className="notice" role="status">
            <Spinner /> Getting yt-dlp ready — this only happens the first time.
          </p>
        ) : null}

        {state.step === 'probing' ? <SkeletonCard /> : null}

        {state.step === 'ready' ? (
          <MediaCard
            probe={state.probe}
            selected={selected}
            audioPreview={state.probe.choices[selected]?.kind === 'audio'}
            footer={
              <>
                {state.error ? (
                  <p className="alert inline" role="alert">
                    {state.error}
                    {needsCookies(state.error) ? cookiesLink : null}
                  </p>
                ) : null}
                <div className="actions">
                  {hosted ? (
                    <div className="destination" />
                  ) : (
                    <div className="destination">
                      <span className="destination-label">Saves to</span>
                      <span className="destination-path">
                        <Folder />
                        <span className="path" title={destination(settings, state.probe)}>
                          {shortPath(destination(settings, state.probe))}
                        </span>
                        {settings?.canChooseFolder ? (
                          <button
                            type="button"
                            className="change"
                            onClick={() => void onChooseFolder()}
                            disabled={choosing}
                          >
                            {choosing ? 'Choosing…' : 'Change'}
                          </button>
                        ) : null}
                      </span>
                    </div>
                  )}
                  <button
                    className="button primary"
                    type="button"
                    disabled={choosing}
                    onClick={() => void onSave(state.probe)}
                  >
                    {state.probe.kind === 'playlist' ? `Download ${state.probe.count}` : 'Download'}
                  </button>
                </div>
              </>
            }
          >
            {state.probe.playlistUrl ? (
              <button type="button" className="playlist-offer" onClick={() => void load(state.probe.playlistUrl!)}>
                <span>This video is part of a playlist.</span>
                <span className="link">
                  Get the whole playlist <ArrowRight />
                </span>
              </button>
            ) : null}
            <ChoiceList
              choices={state.probe.choices}
              selected={selected}
              onSelect={setSelected}
              showAllVideo={showAllVideo}
              onShowAllVideo={() => setShowAllVideo(true)}
            />
          </MediaCard>
        ) : null}

        {downloads.length > 0 ? (
          <section className="downloads" aria-label="Downloads">
            <div className="downloads-head">
              <h2>Downloads</h2>
              <span className="muted">
                {running > 0 ? `${running} in progress` : 'All done'}
                {finished > 0 ? ' · ' : ''}
                {finished > 0 ? (
                  <button type="button" className="link" onClick={clearFinished}>
                    Clear finished
                  </button>
                ) : null}
              </span>
            </div>
            {downloads.map(d => (
              <DownloadCard
                key={d.key}
                download={d}
                hosted={hosted}
                settings={settings}
                onDismiss={() => dismiss(d.key)}
                onRetry={() => retry(d)}
                errorExtra={d.error && needsCookies(d.error) ? cookiesLink : null}
              />
            ))}
          </section>
        ) : null}
      </main>

      <footer className="footer">
        {hosted
          ? 'Powered by yt-dlp · Only download what you have the right to keep'
          : 'Powered by yt-dlp · Runs entirely on your computer — no accounts, no uploads'}
      </footer>
    </div>
  )
}

function DownloadCard({
  download,
  hosted,
  settings,
  onDismiss,
  onRetry,
  errorExtra,
}: {
  download: Download
  hosted: boolean
  settings?: Settings
  onDismiss: () => void
  onRetry: () => void
  errorExtra: ReactNode
}) {
  const {probe, choice} = download

  if (!probe || !choice) {
    // still waiting, reading the link, or the link itself failed
    return (
      <article className="card">
        <div className="card-body">
          <div className="progress">
            <div className="progress-top">
              <p className="progress-label path" title={download.url}>
                {shortPath(download.url, 60)}
              </p>
            </div>
            {download.status === 'error' ? (
              <p className="alert inline" role="alert">
                {download.error}
                {errorExtra}
              </p>
            ) : (
              <div className="bar indeterminate" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
                <span />
              </div>
            )}
            <div className="progress-bottom">
              <p className="muted">
                {download.status === 'queued'
                  ? 'Waiting…'
                  : download.status === 'probing'
                    ? 'Reading link…'
                    : 'Couldn’t read this link'}
              </p>
              <div className="done-actions">
                {download.status === 'error' ? (
                  <button type="button" className="button small" onClick={onRetry}>
                    Retry
                  </button>
                ) : null}
                <button type="button" className="button ghost small" onClick={onDismiss}>
                  <X /> {download.status === 'error' ? 'Dismiss' : 'Cancel'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </article>
    )
  }

  const audioPreview = choice.kind === 'audio'

  if (download.status === 'done') {
    return (
      <MediaCard probe={probe} selected={choice.index} audioPreview={audioPreview}>
        <div className="done">
          <span className="done-icon">
            <Check />
          </span>
          <div className="done-text">
            <p className="done-title">
              {probe.kind === 'playlist'
                ? `${download.count} ${download.count === 1 ? 'file' : 'files'} ${hosted ? 'ready' : 'saved'}`
                : hosted
                  ? 'Ready'
                  : 'Saved'}
            </p>
            <p className="muted">
              <span className="path" title={download.path}>
                {shortPath(download.path ?? '', 60)}
              </span>
              {download.failed
                ? ` · ${download.failed} unavailable ${download.failed === 1 ? 'video' : 'videos'} skipped`
                : ''}
            </p>
          </div>
          <div className="done-actions">
            {hosted ? (
              <a className="button primary" href={fileUrl(download.jobId!)} download>
                {probe.kind === 'playlist' ? 'Save .zip' : 'Save file'}
              </a>
            ) : (
              <button className="button" type="button" onClick={() => void revealJob(download.jobId!)}>
                <Folder /> {settings?.revealLabel ?? 'Show in folder'}
              </button>
            )}
            <button className="button ghost" type="button" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      </MediaCard>
    )
  }

  if (download.status === 'error') {
    return (
      <MediaCard probe={probe} selected={choice.index} audioPreview={audioPreview}>
        <p className="alert inline" role="alert">
          {download.error}
          {errorExtra}
        </p>
        <div className="done-actions">
          <button className="button primary" type="button" onClick={onRetry}>
            Retry
          </button>
          <button className="button ghost" type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </MediaCard>
    )
  }

  return (
    <MediaCard probe={probe} selected={choice.index} audioPreview={audioPreview}>
      <DownloadProgress
        state={download as ActiveDownload}
        destination={hosted ? undefined : destination(settings, probe)}
        onCancel={onDismiss}
      />
    </MediaCard>
  )
}

/**
 * Elide from the LEFT: `…/Artist - Album/01 - Track.mp4` — the album folder is
 * the part that matters. Deliberately not `shortenPath` from
 * src/lib/format.ts, which keeps the head and the extension: that is the right
 * call in a terminal, where you know your own folders. In a browser the tail is
 * what identifies the file, and there is no `$HOME` to shorten.
 */
function shortPath(full: string, max = 46): string {
  if (full.length <= max) return full
  const parts = full.split('/')
  let tail = parts.pop()!
  while (parts.length > 0 && `…/${parts.at(-1)}/${tail}`.length <= max) tail = `${parts.pop()}/${tail}`
  return `…/${tail}`
}

/** Where this download will end up — playlists get their own folder. */
function destination(settings: Settings | undefined, probe: ProbeView): string {
  const dir = settings?.outDir ?? '~/Downloads'
  return probe.kind === 'playlist' && probe.folder ? `${dir}/${probe.folder}` : dir
}

function MediaCard({
  probe,
  selected,
  audioPreview,
  children,
  footer,
}: {
  probe: ProbeView
  selected: number
  audioPreview: boolean
  children: ReactNode
  footer?: ReactNode
}) {
  const meta = [
    probe.author,
    probe.kind === 'playlist' ? `${probe.count} ${probe.count === 1 ? 'video' : 'videos'}` : probe.platform,
    probe.duration ? formatDuration(probe.duration) : undefined,
  ].filter(Boolean)
  return (
    <article className="card" data-selected={selected}>
      <div className="card-head">
        <div className={`thumb${audioPreview ? ' square' : ''}`}>
          {probe.thumbnail ? <img src={probe.thumbnail} alt="" referrerPolicy="no-referrer" /> : null}
          <span className="thumb-icon">{audioPreview ? <Music /> : <Video />}</span>
        </div>
        <div className="card-title">
          <p className="eyebrow">{probe.kind === 'playlist' ? `${probe.platform} playlist` : probe.platform}</p>
          <h2 title={probe.title}>{probe.title}</h2>
          <p className="muted">{meta.join(' · ')}</p>
        </div>
      </div>
      <div className="card-body">{children}</div>
      {footer ? <div className="card-foot">{footer}</div> : null}
    </article>
  )
}

const VISIBLE_VIDEO = 3

function ChoiceList({
  choices,
  selected,
  onSelect,
  showAllVideo,
  onShowAllVideo,
}: {
  choices: ChoiceView[]
  selected: number
  onSelect: (index: number) => void
  showAllVideo: boolean
  onShowAllVideo: () => void
}) {
  const audio = choices.filter(c => c.kind === 'audio')
  const video = choices.filter(c => c.kind === 'video')
  const selectedHidden = video.findIndex(c => c.index === selected) >= VISIBLE_VIDEO
  const visibleVideo = showAllVideo || selectedHidden ? video : video.slice(0, VISIBLE_VIDEO)
  return (
    <div className="choices" role="radiogroup" aria-label="Format">
      {audio.length > 0 ? (
        <fieldset className="group">
          <legend>Audio</legend>
          {audio.map(choice => (
            <ChoiceRow key={choice.index} choice={choice} selected={selected} onSelect={onSelect} />
          ))}
        </fieldset>
      ) : null}
      {video.length > 0 ? (
        <fieldset className="group">
          <legend>Video</legend>
          {visibleVideo.map(choice => (
            <ChoiceRow key={choice.index} choice={choice} selected={selected} onSelect={onSelect} />
          ))}
          {visibleVideo.length < video.length ? (
            <button type="button" className="more" onClick={onShowAllVideo}>
              {video.length - visibleVideo.length} more{' '}
              {video.length - visibleVideo.length === 1 ? 'resolution' : 'resolutions'}
            </button>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  )
}

function ChoiceRow({
  choice,
  selected,
  onSelect,
}: {
  choice: ChoiceView
  selected: number
  onSelect: (index: number) => void
}) {
  const checked = choice.index === selected
  return (
    <label className={`choice${checked ? ' checked' : ''}`}>
      <input type="radio" name="format" className="sr-only" checked={checked} onChange={() => onSelect(choice.index)} />
      <span className="radio" aria-hidden />
      <span className="choice-name">{choice.name}</span>
      <span className="choice-detail">{choice.detail}</span>
      <span className="choice-size">{choice.size?.replace('~', '≈ ') ?? ''}</span>
    </label>
  )
}

function DownloadProgress({
  state,
  destination,
  onCancel,
}: {
  state: ActiveDownload
  destination?: string
  onCancel: () => void
}) {
  const {progress, item, processing, refreshing, choice, probe} = state
  const fraction = progress?.total ? Math.min(1, progress.downloaded / progress.total) : undefined
  // spread the bar over every file: tracks of a playlist, or video + audio parts
  const within = processing ? 1 : (fraction ?? 0)
  const partShare = progress ? (progress.part + within) / Math.max(1, progress.parts) : processing ? 1 : 0
  const overall = item ? (item.item - 1 + partShare) / item.total : partShare
  // a playlist always has an overall position, even between tracks
  const indeterminate = !item && !processing && !refreshing && !progress

  const status = refreshing
    ? 'Link expired — getting a fresh one…'
    : processing
      ? choice.kind === 'audio'
        ? 'Converting and adding cover art…'
        : 'Merging audio and video…'
      : progress
        ? [
            progress.total
              ? `${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)}`
              : formatBytes(progress.downloaded),
            progress.speed ? formatSpeed(progress.speed) : undefined,
            progress.eta ? `${formatEta(progress.eta)} left` : undefined,
          ]
            .filter(Boolean)
            .join(' · ')
        : probe.kind === 'playlist' && !item
          ? 'Reading the playlist…'
          : 'Starting…'

  return (
    <div className="progress">
      <div className="progress-top">
        <p className="progress-label">
          {item ? (
            <>
              Track {item.item} <span className="muted">of {item.total}</span>
            </>
          ) : (
            'Downloading'
          )}
        </p>
        <p className="progress-percent">{indeterminate ? '' : `${Math.round(overall * 100)}%`}</p>
      </div>
      <div
        className={`bar${indeterminate ? ' indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(overall * 100)}
      >
        <span style={{width: indeterminate ? undefined : `${overall * 100}%`}} />
      </div>
      <div className="progress-bottom">
        <p className="muted tabular">{status}</p>
        <button type="button" className="button ghost small" onClick={onCancel}>
          <X /> Cancel
        </button>
      </div>
      <p className="target">
        {destination ? (
          <>
            <Folder />{' '}
            <span className="path" title={destination}>
              {shortPath(destination, 60)}
            </span>
          </>
        ) : null}
        {probe.kind === 'playlist' && state.saved > 0 ? <span className="muted"> · {state.saved} saved</span> : null}
      </p>
    </div>
  )
}

function SkeletonCard() {
  return (
    <article className="card skeleton" aria-busy="true" aria-label="Reading link">
      <div className="card-head">
        <div className="thumb shimmer" />
        <div className="card-title">
          <span className="line shimmer short" />
          <span className="line shimmer" />
          <span className="line shimmer medium" />
        </div>
      </div>
      <div className="card-body">
        <span className="line shimmer row" />
        <span className="line shimmer row" />
        <span className="line shimmer row" />
      </div>
    </article>
  )
}
