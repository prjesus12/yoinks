import type {JobEvent, ProbeView, Settings} from '../../src/server/types'

export type {ChoiceView, JobEvent, ProbeView, Settings} from '../../src/server/types'

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Can’t reach yoinks. Is `yoinks --web` still running?')
  }
  const data = (await res.json().catch(() => ({}))) as T & {error?: string}
  if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status}).`)
  return data
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch('/api/settings')
  if (!res.ok) throw new Error('Can’t reach yoinks. Is `yoinks --web` still running?')
  return (await res.json()) as Settings
}

/** Opens the system folder dialog on this computer; resolves once it closes. */
export const chooseFolder = () => post<Settings>('/api/choose-folder', {})

export const revealJob = (jobId: string) =>
  fetch(`/api/jobs/${jobId}/reveal`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: '{}',
  }).catch(() => {})

export const probeUrl = (url: string) => post<ProbeView>('/api/probe', {url})

export const startDownload = (probeId: string, choice: number) =>
  post<{jobId: string}>('/api/download', {probeId, choice}).then(r => r.jobId)

export function dropJob(jobId: string) {
  // best effort — the server sweeps leftovers on its own
  void fetch(`/api/jobs/${jobId}`, {method: 'DELETE'}).catch(() => {})
}

/**
 * Follow a job's events. The server ends the stream when the job is over;
 * EventSource would reconnect forever, so the terminal events close it.
 */
export function followJob(jobId: string, onEvent: (event: JobEvent) => void): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`)
  let closed = false
  const close = () => {
    closed = true
    source.close()
  }
  source.onmessage = message => {
    const event = JSON.parse(message.data as string) as JobEvent
    if (event.type === 'done' || event.type === 'error') close()
    onEvent(event)
  }
  source.onerror = () => {
    // a dropped connection reconnects on its own and the server replays
    // history; a closed-for-good one (job gone) reports as an error
    if (!closed && source.readyState === EventSource.CLOSED) {
      onEvent({type: 'error', message: 'Lost the connection to yoinks.'})
    }
  }
  return close
}
