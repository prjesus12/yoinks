import {Directory, File, Paths} from 'expo-file-system'
import {sseReader} from './sse'
import type {JobEvent, ProbeView, Settings} from './types'

export type {ChoiceView, JobEvent, ProbeView, Settings} from './types'

// yt-dlp needs Python and ffmpeg, which an Expo app can't ship — so the phone
// talks to a hosted yoinks server (`node dist/server.js`) and downloads the result.

export type YoinksOptions = {
  /** e.g. https://yoinks.example.com */
  server: string
  /** The server's YOINKS_PASSWORD, if it has one. */
  password?: string
}

export type YoinkOptions = {
  /** Which of the probe's choices (ChoiceView.index). Defaults to the first one. */
  choice?: number
  onEvent?: (event: JobEvent) => void
  /** Where the file lands. Defaults to the app's document directory. */
  directory?: Directory
  signal?: AbortSignal
}

export function createYoinks({server, password}: YoinksOptions) {
  const base = server.replace(/\/+$/, '')
  const headers: Record<string, string> = password ? {authorization: `Basic ${btoa(`yoinks:${password}`)}`} : {}

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${base}/${path}`, {
        ...init,
        headers: {...headers, ...(init.body ? {'content-type': 'application/json'} : {})},
      })
    } catch {
      throw new Error(`Can’t reach yoinks at ${base}.`)
    }
    const data = (await res.json().catch(() => ({}))) as T & {error?: string}
    if (res.status === 401) throw new Error('Wrong yoinks password.')
    if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status}).`)
    return data
  }

  const post = <T>(path: string, body: unknown) => request<T>(path, {method: 'POST', body: JSON.stringify(body)})

  const getSettings = () => request<Settings>('api/settings')

  /** Look a url up: title, thumbnail and the formats on offer. */
  const probe = (url: string) => post<ProbeView>('api/probe', {url})

  const startDownload = (probeId: string, choice: number) =>
    post<{jobId: string}>('api/download', {probeId, choice}).then(r => r.jobId)

  const cancel = (jobId: string) => fetch(`${base}/api/jobs/${jobId}`, {method: 'DELETE', headers}).catch(() => {})

  /**
   * Follow a job until it's done. RN has no EventSource, but its XHR hands out
   * the body as it streams in, which is all SSE needs.
   */
  function follow(jobId: string, onEvent: (event: JobEvent) => void, signal?: AbortSignal) {
    return new Promise<Extract<JobEvent, {type: 'done'}>>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const read = sseReader()
      let settled = false
      const finish = (error?: Error, done?: Extract<JobEvent, {type: 'done'}>) => {
        if (settled) return
        settled = true
        xhr.abort()
        signal?.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve(done!)
      }
      const onAbort = () => finish(new Error('Cancelled.'))
      signal?.addEventListener('abort', onAbort)

      xhr.open('GET', `${base}/api/jobs/${jobId}/events`)
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
      const drain = () => {
        for (const data of read(xhr.responseText)) {
          const event = JSON.parse(data) as JobEvent
          onEvent(event)
          if (event.type === 'done') finish(undefined, event)
          if (event.type === 'error') finish(new Error(event.message))
        }
      }
      xhr.onprogress = drain
      xhr.onload = () => {
        drain() // whatever came with the last chunk
        finish(new Error(xhr.status >= 400 ? `Job failed (${xhr.status}).` : 'The job ended without finishing.'))
      }
      xhr.onerror = () => finish(new Error('Lost the connection to yoinks.'))
      xhr.send()
    })
  }

  /** Hand the finished file (a zip for playlists) to the device. */
  async function save(jobId: string, directory: Directory = Paths.document) {
    return File.downloadFileAsync(`${base}/api/jobs/${jobId}/file`, directory, {headers, idempotent: true})
  }

  /** probe → download → wait → save, in one go. Accepts a url or an existing probe. */
  async function yoink(target: string | ProbeView, options: YoinkOptions = {}) {
    const found = typeof target === 'string' ? await probe(target) : target
    const choice = options.choice ?? found.choices[0]?.index
    if (choice === undefined) throw new Error('Nothing to download there.')
    const jobId = await startDownload(found.id, choice)
    try {
      await follow(jobId, options.onEvent ?? (() => {}), options.signal)
      return await save(jobId, options.directory)
    } finally {
      void cancel(jobId) // frees the server's copy either way
    }
  }

  return {getSettings, probe, startDownload, follow, save, cancel, yoink}
}

export type Yoinks = ReturnType<typeof createYoinks>
