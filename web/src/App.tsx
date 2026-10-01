import {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react'
import {formatBytes, formatDuration, formatEta, formatSpeed} from '../../src/lib/format'
import {
  chooseFolder,
  dropJob,
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

// set by the desktop app (?shell=darwin|win32|linux) — styles the title bar
const SHELL = new URLSearchParams(location.search).get('shell') ?? undefined
if (SHELL) document.documentElement.dataset.shell = SHELL

type Progress = Extract<JobEvent, {type: 'progress'}>

type State =
  | {step: 'idle'; error?: string}
  | {step: 'probing'}
  | {step: 'ready'; probe: ProbeView; error?: string}
  | {
      step: 'downloading'
      probe: ProbeView
      choice: ChoiceView
      jobId: string
      progress?: Progress
      processing: boolean
      refreshing: boolean
      item?: {item: number; total: number}
      saved: number
    }
  | {step: 'done'; probe: ProbeView; choice: ChoiceView; jobId: string; path: string; count: number; failed: number}

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

export function App() {
  const [url, setUrl] = useState('')
  const [state, setState] = useState<State>({step: 'idle'})
  const [selected, setSelected] = useState(0)
  const [showAllVideo, setShowAllVideo] = useState(false)
  const [settings, setSettings] = useState<Settings>()
  const [choosing, setChoosing] = useState(false)
  const [components, setComponents] = useState<ComponentsView>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const runRef = useRef<{jobId: string; stop: () => void} | undefined>(undefined)

  useEffect(() => {
    inputRef.current?.focus()
    getSettings().then(setSettings, () => {})
    getComponents().then(setComponents, () => {})
    return () => runRef.current?.stop()
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

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void load(url)
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

    let failed = false
    const fail = (message: string) => {
      if (failed) return
      failed = true
      runRef.current?.stop()
      runRef.current = undefined
      dropJob(jobId)
      setState({step: 'ready', probe, error: message})
    }

    setState({step: 'downloading', probe, choice, jobId, processing: false, refreshing: false, saved: 0})
    const update = (patch: Partial<Extract<State, {step: 'downloading'}>>) =>
      setState(prev => (prev.step === 'downloading' ? {...prev, ...patch} : prev))

    // the server writes the files itself, like the terminal does — the page
    // only follows along
    const stop = followJob(jobId, event => {
      switch (event.type) {
        case 'progress':
          update({progress: event, processing: false})
          break
        case 'processing':
          update({processing: true})
          break
        case 'refreshing':
          update({refreshing: true, progress: undefined})
          break
        case 'item':
          update({item: {item: event.item, total: event.total}, progress: undefined, processing: false})
          break
        case 'file':
          update({saved: event.index + 1})
          break
        case 'done':
          runRef.current = undefined
          setState({
            step: 'done',
            probe,
            choice,
            jobId,
            path: event.path,
            count: event.count,
            failed: event.failed,
          })
          break
        case 'error':
          fail(event.message)
          break
      }
    })
    runRef.current = {jobId, stop}
  }

  function onCancel() {
    const run = runRef.current
    if (!run) return
    run.stop()
    dropJob(run.jobId)
    runRef.current = undefined
    setState(prev => (prev.step === 'downloading' ? {step: 'ready', probe: prev.probe} : prev))
  }

  function reset() {
    setUrl('')
    setState({step: 'idle'})
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const busy = state.step === 'probing' || state.step === 'downloading'

  return (
    <div className="shell">
      <header className="header">
        <button type="button" className="brand" onClick={reset} disabled={state.step === 'downloading'} aria-label="yoinks — start over">
          <Logo height={16} />
        </button>
        <div className="header-end">
          {SHELL ? null : (
            <span className="badge">
              <span className="dot" aria-hidden /> Running on this computer
            </span>
          )}
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
      />

      <main className="main">
        <section className="hero">
          <h1>Save video and music from anywhere.</h1>
          <p className="lede">
            YouTube, X, Instagram, TikTok and 1,800+ sites. Playlists arrive as albums — a folder per album, with
            cover art on every track.
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
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a link — video, song or playlist"
            value={url}
            disabled={busy}
            onChange={e => setUrl(e.target.value)}
            onPaste={e => {
              // pasting a link is the whole intent — skip the extra click
              const pasted = e.clipboardData.getData('text').trim()
              if (/^https?:\/\/\S+$/.test(pasted) && url.trim() === '') {
                e.preventDefault()
                void load(pasted)
              }
            }}
          />
          <button className="button primary" type="submit" disabled={busy || !url.trim()}>
            {state.step === 'probing' ? <Spinner /> : 'Continue'}
          </button>
        </form>

        {state.step === 'idle' && state.error ? <p className="alert" role="alert">{state.error}</p> : null}
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
                {state.error ? <p className="alert inline" role="alert">{state.error}</p> : null}
                <div className="actions">
                  <div className="destination">
                    <span className="destination-label">Saves to</span>
                    <span className="destination-path">
                      <Folder />
                      <span className="path" title={destination(settings, state.probe)}>
                        {shortPath(destination(settings, state.probe))}
                      </span>
                      {settings?.canChooseFolder ? (
                        <button type="button" className="change" onClick={() => void onChooseFolder()} disabled={choosing}>
                          {choosing ? 'Choosing…' : 'Change'}
                        </button>
                      ) : null}
                    </span>
                  </div>
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

        {state.step === 'downloading' ? (
          <MediaCard probe={state.probe} selected={state.choice.index} audioPreview={state.choice.kind === 'audio'}>
            <DownloadProgress state={state} destination={destination(settings, state.probe)} onCancel={onCancel} />
          </MediaCard>
        ) : null}

        {state.step === 'done' ? (
          <MediaCard probe={state.probe} selected={state.choice.index} audioPreview={state.choice.kind === 'audio'}>
            <div className="done">
              <span className="done-icon">
                <Check />
              </span>
              <div className="done-text">
                <p className="done-title">
                  {state.probe.kind === 'playlist'
                    ? `${state.count} ${state.count === 1 ? 'file' : 'files'} saved`
                    : 'Saved'}
                </p>
                <p className="muted">
                  <span className="path" title={state.path}>{shortPath(state.path, 60)}</span>
                  {state.failed > 0
                    ? ` · ${state.failed} unavailable ${state.failed === 1 ? 'video' : 'videos'} skipped`
                    : ''}
                </p>
              </div>
              <div className="done-actions">
                <button className="button" type="button" onClick={() => void revealJob(state.jobId)}>
                  <Folder /> {settings?.revealLabel ?? 'Show in folder'}
                </button>
                <button className="button primary" type="button" onClick={reset}>
                  Download another
                </button>
              </div>
            </div>
          </MediaCard>
        ) : null}
      </main>

      <footer className="footer">
        Powered by yt-dlp · Runs entirely on your computer — no accounts, no uploads
      </footer>
    </div>
  )
}

/** Long paths keep their end — the album folder is the part that matters. */
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
              {video.length - visibleVideo.length} more {video.length - visibleVideo.length === 1 ? 'resolution' : 'resolutions'}
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
      <input
        type="radio"
        name="format"
        className="sr-only"
        checked={checked}
        onChange={() => onSelect(choice.index)}
      />
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
  state: Extract<State, {step: 'downloading'}>
  destination: string
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
            progress.total ? `${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)}` : formatBytes(progress.downloaded),
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
        <Folder /> <span className="path" title={destination}>{shortPath(destination, 60)}</span>
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
