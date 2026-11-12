import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {download, probe, type DownloadChoice, type DownloadHandlers} from './ytdlp.js'

// a fake yt-dlp: a shell script that prints whatever a test needs and then
// hangs, so the timeout / cancel paths can be observed without a network
const posixOnly = process.platform === 'win32' ? 'posix only' : false

async function fakeYtDlp(script: string): Promise<{bin: string; dir: string}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-fake-'))
  const bin = path.join(dir, 'yt-dlp')
  await fs.writeFile(bin, `#!/bin/sh\n${script}\n`, {mode: 0o755})
  return {bin, dir}
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition never became true')
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false)

const CHOICE: DownloadChoice = {label: '720p · mp4', kind: 'video', format: 'mp4', args: []}

const noopHandlers: DownloadHandlers = {onProgress: () => {}, onProcessing: () => {}}

test('probe returns the parsed info when yt-dlp succeeds', {skip: posixOnly}, async () => {
  const {bin, dir} = await fakeYtDlp(`echo '{"title":"a song","formats":[]}'`)
  try {
    const result = await probe(bin, 'https://example.com/v', {timeoutMs: 5000})
    assert.equal(result.info.title, 'a song')
    // the metadata is kept so the download can skip re-extraction
    assert.equal(await exists(result.infoJsonPath), true)
    await fs.rm(result.infoJsonPath, {force: true})
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('probe reports what yt-dlp said when it fails', {skip: posixOnly}, async () => {
  const {bin, dir} = await fakeYtDlp('echo "ERROR: [youtube] nope: Video unavailable" >&2\nexit 1')
  try {
    await assert.rejects(probe(bin, 'https://example.com/v', {timeoutMs: 5000}), /Video unavailable/)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('download reports the finished file', {skip: posixOnly}, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  const target = path.join(outDir, 'track.mp4')
  const {bin, dir} = await fakeYtDlp(
    [`echo "[download] Destination: ${target}"`, `touch "${target}"`, `echo "${target}"`].join('\n'),
  )
  try {
    const result = await download(
      {ytdlp: bin, url: 'https://example.com/v', choice: CHOICE, outDir, idleTimeoutMs: 5000},
      noopHandlers,
    )
    assert.deepEqual(result, {filepath: target, count: 1, failed: 0})
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
    await fs.rm(outDir, {recursive: true, force: true})
  }
})

test('probe gives up on a hung extraction instead of holding a process forever', {skip: posixOnly}, async () => {
  const {bin, dir} = await fakeYtDlp('sleep 30')
  try {
    const started = Date.now()
    await assert.rejects(probe(bin, 'https://example.com/v', {timeoutMs: 200}), /timed out/i)
    assert.ok(Date.now() - started < 10_000, 'the timeout must not wait for the child to finish on its own')
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('download gives up on a transfer that stops reporting progress', {skip: posixOnly}, async () => {
  const {bin, dir} = await fakeYtDlp('echo "YOINK|10|100|NA|NA|NA"\nsleep 30')
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  try {
    const started = Date.now()
    await assert.rejects(
      download({ytdlp: bin, url: 'https://example.com/v', choice: CHOICE, outDir, idleTimeoutMs: 300}, noopHandlers),
      /stalled/i,
    )
    assert.ok(Date.now() - started < 10_000, 'the stall guard must not wait for the child to finish on its own')
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
    await fs.rm(outDir, {recursive: true, force: true})
  }
})

test('cancelling waits for the partial files to be gone', {skip: posixOnly}, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  const target = path.join(outDir, 'track.mp4')
  const partial = `${target}.part`
  const {bin, dir} = await fakeYtDlp(
    [`echo "[download] Destination: ${target}"`, `touch "${target}" "${partial}"`, 'sleep 30'].join('\n'),
  )
  try {
    const controller = new AbortController()
    // the stall guard must not be able to win the race against the abort
    const running = download(
      {ytdlp: bin, url: 'https://example.com/v', choice: CHOICE, outDir, idleTimeoutMs: 60_000},
      noopHandlers,
      controller.signal,
    )
    await waitFor(() => exists(partial))
    controller.abort()
    await assert.rejects(running, /cancelled/i)
    // the promise only settles after cleanup, so nothing is left half-written
    assert.equal(await exists(partial), false, `${partial} survived the cancel`)
    assert.equal(await exists(target), false, `${target} survived the cancel`)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
    await fs.rm(outDir, {recursive: true, force: true})
  }
})
