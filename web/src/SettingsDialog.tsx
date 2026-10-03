import {useEffect, useRef, useState, type ReactNode} from 'react'
import {isNewer} from '../../src/lib/version'
import {checkForUpdates, removeCookies, setAutoUpdate, updateYtDlp, uploadCookies, type ComponentsView, type Settings} from './api'
import {Check, Folder, Refresh, Spinner, X} from './icons'

// re-check GitHub when the panel opens, at most this often
const RECHECK_AFTER = 60 * 60 * 1000

export function updateAvailable(components?: ComponentsView): boolean {
  const {version, latest} = components?.ytdlp ?? {}
  return Boolean(version && latest && isNewer(latest, version))
}

export function SettingsDialog({
  open,
  onClose,
  settings,
  onChooseFolder,
  choosing,
  components,
  onComponents,
  onSettings,
}: {
  open: boolean
  onClose: () => void
  settings?: Settings
  onChooseFolder: () => void
  choosing: boolean
  components?: ComponentsView
  onComponents: (components: ComponentsView) => void
  onSettings: (settings: Settings) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [working, setWorking] = useState<'check' | 'update' | undefined>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open || !components || working) return
    const stale = Date.now() - (components.ytdlp.checkedAt ?? 0) > RECHECK_AFTER
    if (stale) void run('check')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, [open])

  async function run(action: 'check' | 'update') {
    setWorking(action)
    setError(undefined)
    try {
      const next = action === 'check' ? await checkForUpdates() : await updateYtDlp()
      onComponents(next)
      if (next.ytdlp.error) setError(next.ytdlp.error)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(undefined)
    }
  }

  async function toggleAuto(enabled: boolean) {
    try {
      onComponents(await setAutoUpdate(enabled))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const [cookieBusy, setCookieBusy] = useState(false)
  const [cookieError, setCookieError] = useState<string>()
  const fileRef = useRef<HTMLInputElement>(null)

  async function onCookieFile(file: File | undefined) {
    if (!file) return
    setCookieBusy(true)
    setCookieError(undefined)
    try {
      onSettings(await uploadCookies(await file.text()))
    } catch (e) {
      setCookieError((e as Error).message)
    } finally {
      setCookieBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function onCookieRemove() {
    setCookieBusy(true)
    setCookieError(undefined)
    try {
      onSettings(await removeCookies())
    } catch (e) {
      setCookieError((e as Error).message)
    } finally {
      setCookieBusy(false)
    }
  }

  const hosted = Boolean(settings?.hosted)
  const cookies = settings?.cookies
  const yt = components?.ytdlp
  const hasUpdate = updateAvailable(components)
  const busy = Boolean(working) || Boolean(yt?.busy)

  let status: ReactNode
  if (working === 'update' || yt?.busy) status = <span className="pill">Updating…</span>
  else if (working === 'check') status = <span className="pill">Checking…</span>
  else if (hasUpdate) status = <span className="pill accent">{yt!.latest} available</span>
  else if (yt?.latest && yt.version)
    status = (
      <span className="pill ok">
        <Check size={12} /> Up to date
      </span>
    )

  return (
    <dialog
      ref={ref}
      className="sheet"
      onClose={onClose}
      onClick={e => {
        // a click on the backdrop (the dialog element itself) closes it
        if (e.target === ref.current) onClose()
      }}
      aria-labelledby="settings-title"
    >
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <X />
          </button>
        </div>

        {hosted ? (
          <section className="section">
            <h3>YouTube cookies</h3>
            <div className="row">
              <div className="row-text">
                <p className="row-title">
                  cookies.txt{' '}
                  {cookies?.set ? <span className="pill ok"><Check size={12} /> Active</span> : <span className="pill">Not set</span>}
                </p>
                <p className="row-sub">
                  {cookies?.updatedAt ? `Uploaded ${new Date(cookies.updatedAt).toLocaleString()}` : 'Used when YouTube asks to confirm you’re not a bot.'}
                </p>
              </div>
              <div className="row-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".txt,text/plain"
                  hidden
                  onChange={e => void onCookieFile(e.target.files?.[0])}
                />
                <button type="button" className="button small primary" onClick={() => fileRef.current?.click()} disabled={cookieBusy}>
                  {cookieBusy ? <Spinner /> : null} {cookies?.set ? 'Replace' : 'Upload'}
                </button>
                {cookies?.set ? (
                  <button type="button" className="button small" onClick={() => void onCookieRemove()} disabled={cookieBusy}>
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
            <p className="section-note">
              Export them in Netscape format from a private window signed in to a spare Google account (not your
              main one). They’re stored on the server, readable only by it.
            </p>
            {cookieError ? (
              <p className="alert inline" role="alert">
                {cookieError}
              </p>
            ) : null}
          </section>
        ) : null}

        {hosted ? null : <section className="section">
          <h3>Downloads</h3>
          <div className="row">
            <div className="row-text">
              <p className="row-title">Save to</p>
              <p className="row-sub path" title={settings?.outDir}>
                {settings?.outDir ?? '~/Downloads'}
              </p>
            </div>
            {settings?.canChooseFolder ? (
              <button type="button" className="button small" onClick={onChooseFolder} disabled={choosing}>
                <Folder /> {choosing ? 'Choosing…' : 'Change'}
              </button>
            ) : null}
          </div>
          <p className="section-note">Playlists get their own “Artist - Album” folder inside it.</p>
        </section>}

        {hosted ? null : <section className="section">
          <h3>Components</h3>

          <div className="row">
            <div className="row-text">
              <p className="row-title">
                yt-dlp {status}
              </p>
              <p className="row-sub">
                {yt?.version ? <span className="mono">{yt.version}</span> : yt?.busy ? 'Installing…' : 'Not installed'}
                {yt?.version ? (yt.managed ? ' · yoinks’ own copy' : ' · installed on your system') : ''}
              </p>
            </div>
            <div className="row-actions">
              {hasUpdate || (yt && !yt.managed && yt.version) ? (
                <button type="button" className="button small primary" onClick={() => void run('update')} disabled={busy}>
                  {working === 'update' ? <Spinner /> : null}
                  {hasUpdate ? 'Update' : 'Use yoinks’ copy'}
                </button>
              ) : (
                <button
                  type="button"
                  className="button small"
                  onClick={() => void run('check')}
                  disabled={busy}
                  aria-label="Check for updates"
                >
                  {working === 'check' ? <Spinner /> : <Refresh />} Check
                </button>
              )}
            </div>
          </div>
          {yt && !yt.managed && yt.version ? (
            <p className="section-note">
              This yt-dlp is updated by whatever installed it (pipx, Homebrew…). Switch to yoinks’ own copy of the
              official release to update it from here — it also handles YouTube’s newest protections best.
            </p>
          ) : null}

          <label className="row toggle-row">
            <div className="row-text">
              <p className="row-title">Update automatically</p>
              <p className="row-sub">Checks once a day. YouTube changes often — staying current avoids failed downloads.</p>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={components?.autoUpdate ?? true}
              disabled={!components}
              onChange={e => void toggleAuto(e.target.checked)}
            />
          </label>

          <div className="row">
            <div className="row-text">
              <p className="row-title">ffmpeg</p>
              <p className="row-sub">
                {components?.ffmpeg.source === 'missing' ? (
                  'Not found — mp3, m4a and high-resolution video need it'
                ) : (
                  <>
                    {components?.ffmpeg.version ? <span className="mono">{components.ffmpeg.version}</span> : null}
                    {components?.ffmpeg.source === 'bundled'
                      ? ' · bundled with yoinks, updated with the app'
                      : components?.ffmpeg.source === 'system'
                        ? ' · installed on your system'
                        : ''}
                  </>
                )}
              </p>
            </div>
          </div>

          {error ? (
            <p className="alert inline" role="alert">
              {error}
            </p>
          ) : null}
        </section>}

        <p className="sheet-foot">yoinks {components?.appVersion ?? ''}</p>
      </div>
    </dialog>
  )
}
