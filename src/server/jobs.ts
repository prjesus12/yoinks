// Download jobs: the event fan-out, the run itself, cancellation and the hourly sweep.

import fs from 'node:fs/promises'
import path from 'node:path'
import {addToHistory} from '../lib/history.js'
import {downloadWithFreshInfo} from '../lib/engine.js'
import {findFfmpeg, type DownloadChoice, type DownloadHandlers} from '../lib/ytdlp.js'
import {getYtDlp} from './ytdlp-setup.js'
import {prettyPath} from './views.js'
import type {Job, Probe, ServerState} from './state.js'
import type {JobEvent} from './types.js'

const TTL = 60 * 60 * 1000 // probes and finished jobs are dropped after an hour

function emit(job: Job, event: JobEvent) {
  if (event.type === 'progress') {
    job.lastProgress = event
    // yt-dlp reports many times a second — a few updates are plenty
    const now = Date.now()
    if (now - job.lastProgressAt < 150) return
    job.lastProgressAt = now
  } else {
    job.history.push(event)
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const res of job.listeners) res.write(payload)
}

export async function runJob(state: ServerState, job: Job, probe: Probe, choice: DownloadChoice) {
  const handlers: DownloadHandlers = {
    onProgress: p =>
      emit(job, {
        type: 'progress',
        downloaded: p.downloadedBytes,
        total: p.totalBytes,
        speed: p.speed,
        eta: p.eta,
        part: p.part,
        parts: p.totalParts,
      }),
    onProcessing: () => emit(job, {type: 'processing'}),
    onItem: (item: number, total: number) => emit(job, {type: 'item', item, total}),
    onFile: (filepath: string) => {
      job.saved++
      emit(job, {type: 'file', index: job.saved - 1, name: path.basename(filepath)})
    },
  }
  const {signal} = job.controller
  try {
    const ffmpegLocation = await findFfmpeg()
    const target = job.dir ?? state.outDir
    await fs.mkdir(target, {recursive: true})
    const base = {
      ytdlp: await getYtDlp(state),
      ffmpegLocation,
      url: probe.url,
      choice,
      outDir: target,
      template: state.template,
    }
    const result = await downloadWithFreshInfo(
      {...base, infoJsonPath: probe.infoJsonPath},
      handlers,
      // media urls in the cached info can expire — the policy retries fresh once
      {signal, onRefresh: () => emit(job, {type: 'refreshing'})},
    )
    if (!state.hosted) addToHistory(probe.url)
    job.result = {path: result.filepath, isFolder: Boolean(choice.playlistFolder)}
    emit(job, {
      type: 'done',
      count: result.count,
      failed: result.failed,
      path: state.hosted ? path.basename(result.filepath) : prettyPath(result.filepath),
    })
  } catch (error) {
    if (signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    // the terminal running --web is the only place to look when this goes wrong
    console.error(`✗ ${probe.url}: ${message}`)
    emit(job, {type: 'error', message})
  } finally {
    job.finished = true
    for (const res of job.listeners) res.end()
    job.listeners.clear()
  }
}

/** Downloads still running on this server — the desktop app asks before quitting. */
export const jobsRunning = (state: ServerState) => [...state.jobs.values()].filter(job => !job.finished).length

/** Cancel (a no-op once finished). download() removes its own partial files. */
export function dropJob(state: ServerState, job: Job) {
  job.controller.abort()
  state.jobs.delete(job.id)
  if (job.dir) void fs.rm(job.dir, {recursive: true, force: true})
  for (const res of job.listeners) res.end()
}

export function sweep(state: ServerState) {
  const {probes, jobs} = state
  const cutoff = Date.now() - (state.hosted?.fileTtlMs ?? TTL)
  for (const probe of probes.values()) {
    if (probe.createdAt < cutoff) {
      probes.delete(probe.id)
      void fs.rm(probe.infoJsonPath, {force: true})
    }
  }
  for (const job of jobs.values()) if (job.finished && job.createdAt < cutoff) dropJob(state, job)
  state.probeLimiter.prune()
  state.downloadLimiter.prune()
  // the password meter sees unauthenticated traffic, so it grows fastest of all
  state.authLimiter.prune()
}
