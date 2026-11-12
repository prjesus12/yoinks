import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {choicesFor, downloadWithFreshInfo, withFreshInfo} from './engine.js'
import type {DownloadChoice, DownloadHandlers, VideoInfo} from './ytdlp.js'

/**
 * The retry policy every surface shares: download with the probe's cached
 * metadata, and fall back to a fresh extraction when that turns out to be
 * stale. A cancel or a playlist must never retry.
 */

type Attempt = {usedCached: boolean[]}

const recorder = (): Attempt => ({usedCached: []})

test('a first attempt that works is not retried', async () => {
  const attempt = recorder()
  let refreshes = 0
  const result = await withFreshInfo(
    async useCached => {
      attempt.usedCached.push(useCached)
      return 'file.mp4'
    },
    {playlist: false, onRefresh: () => refreshes++},
  )
  assert.equal(result, 'file.mp4')
  assert.deepEqual(attempt.usedCached, [true], 'exactly one attempt, with the cached info')
  assert.equal(refreshes, 0, 'nothing to refresh when the first attempt works')
})

test('a stale cached extraction is retried once, fresh, after onRefresh', async () => {
  const events: string[] = []
  const result = await withFreshInfo(
    async useCached => {
      events.push(useCached ? 'cached' : 'fresh')
      if (useCached) throw new Error('HTTP Error 403: Forbidden')
      return 'file.mp4'
    },
    {playlist: false, onRefresh: () => events.push('refresh')},
  )
  assert.equal(result, 'file.mp4')
  // the order matters: the caller is told before the second attempt, not after
  assert.deepEqual(events, ['cached', 'refresh', 'fresh'])
})

test('a cancelled download is not retried', async () => {
  const attempt = recorder()
  let refreshes = 0
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    withFreshInfo(
      async useCached => {
        attempt.usedCached.push(useCached)
        throw new Error('Download cancelled.')
      },
      {playlist: false, signal: controller.signal, onRefresh: () => refreshes++},
    ),
    /cancelled/i,
  )
  assert.deepEqual(attempt.usedCached, [true], 'a cancel is the user asking to stop, not a stale url')
  assert.equal(refreshes, 0)
})

test('a playlist is not retried, because it always extracts fresh', async () => {
  const attempt = recorder()
  let refreshes = 0
  await assert.rejects(
    withFreshInfo(
      async useCached => {
        attempt.usedCached.push(useCached)
        throw new Error('video unavailable')
      },
      {playlist: true, onRefresh: () => refreshes++},
    ),
    /unavailable/,
  )
  assert.deepEqual(attempt.usedCached, [true])
  assert.equal(refreshes, 0)
})

test('a second failure propagates instead of looping', async () => {
  const attempt = recorder()
  let refreshes = 0
  await assert.rejects(
    withFreshInfo(
      async useCached => {
        attempt.usedCached.push(useCached)
        throw new Error(useCached ? 'stale' : 'really broken')
      },
      {playlist: false, onRefresh: () => refreshes++},
    ),
    /really broken/,
  )
  assert.deepEqual(attempt.usedCached, [true, false], 'one retry, never more')
  assert.equal(refreshes, 1)
})

const VIDEO = {_type: 'video', title: 'A Video'} as VideoInfo
const PLAYLIST = {
  _type: 'playlist',
  title: 'Album - A Record',
  uploader: 'The Artist',
  entries: [{title: 'One', channel: 'The Artist'}, {title: 'Two', channel: 'The Artist'}],
} as VideoInfo

test('a video gets its own formats', () => {
  const choices = choicesFor(VIDEO)
  assert.equal(
    choices.every(choice => choice.playlistFolder === undefined),
    true,
    'a single video never offers a playlist folder',
  )
  assert.equal(
    choices.some(choice => choice.kind === 'audio'),
    true,
    'a video still offers the audio-only formats',
  )
})

test('a playlist gets whole-playlist choices', () => {
  const choices = choicesFor(PLAYLIST)
  assert.equal(choices.length, 3, 'two audio formats plus the video one')
  assert.equal(
    choices.every(choice => choice.playlistFolder !== undefined),
    true,
    'every playlist choice downloads the whole thing into its folder',
  )
  assert.match(choices[0]!.label, /all 2 tracks/)
})

// ---------------------------------------------------------------------------
// the production entry point, driven through a real child process. These are
// the four ways `downloadWithFreshInfo` could quietly do the wrong thing.

const posixOnly = process.platform === 'win32' ? 'posix only' : false
const noopHandlers: DownloadHandlers = {onProgress: () => {}, onProcessing: () => {}}
const VIDEO_CHOICE: DownloadChoice = {label: '720p · mp4', kind: 'video', format: 'mp4', args: []}
const PLAYLIST_CHOICE: DownloadChoice = {
  label: 'all 2 tracks · mp3',
  kind: 'audio',
  format: 'mp3',
  args: [],
  playlistFolder: 'Canned Artist - Canned Album',
}

/** A fake yt-dlp that logs its argv and then runs whatever the test needs. */
async function fakeYtDlp(script: string): Promise<{bin: string; dir: string; calls: () => Promise<string[]>}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-engine-'))
  const bin = path.join(dir, 'yt-dlp')
  const log = path.join(dir, 'calls.log')
  await fs.writeFile(bin, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`, {mode: 0o755})
  const calls = async () =>
    (await fs.readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
  return {bin, dir, calls}
}

const succeed = (dir: string) => `touch "${path.join(dir, 'a.mp4')}"\necho "${path.join(dir, 'a.mp4')}"\nexit 0`
const fail = (message: string) => `echo "ERROR: ${message}" >&2\nexit 1`

const options = (bin: string, dir: string, choice: DownloadChoice = VIDEO_CHOICE) => ({
  ytdlp: bin,
  url: 'https://example.com/v',
  choice,
  outDir: dir,
  infoJsonPath: path.join(dir, 'info.json'),
})

test('the retry drops the cached metadata and starts from the url', {skip: posixOnly}, async () => {
  const {bin, dir, calls} = await fakeYtDlp(`case "$*" in *--load-info-json*) ${fail('HTTP Error 403: Forbidden')} ;; *) ${succeed('%DIR%')} ;; esac`)
  const withDir = await fakeYtDlp('exit 1')
  try {
    const script = await fs.readFile(bin, 'utf8')
    await fs.writeFile(bin, script.replaceAll('%DIR%', dir), {mode: 0o755})
    const result = await downloadWithFreshInfo(options(bin, dir), noopHandlers, {onRefresh: () => {}})
    assert.equal(result.filepath, path.join(dir, 'a.mp4'))
    const seen = await calls()
    assert.equal(seen.length, 2, 'one cached attempt and one fresh one')
    assert.match(seen[0]!, /--load-info-json/, 'the first attempt reuses the probe metadata')
    assert.equal(/--load-info-json/.test(seen[1]!), false, 'the retry must not reuse stale metadata')
    assert.match(seen[1]!, /https:\/\/example\.com\/v/, 'the retry extracts from the url')
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
    await fs.rm(withDir.dir, {recursive: true, force: true})
  }
})

test('a playlist choice is never retried', {skip: posixOnly}, async () => {
  const {bin, dir, calls} = await fakeYtDlp(fail('video unavailable'))
  try {
    let refreshes = 0
    await assert.rejects(
      downloadWithFreshInfo(options(bin, dir, PLAYLIST_CHOICE), noopHandlers, {onRefresh: () => refreshes++}),
      /unavailable/,
    )
    assert.equal((await calls()).length, 1, 'a playlist extracts fresh already — one attempt only')
    assert.equal(refreshes, 0)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('a cancelled download is never retried', {skip: posixOnly}, async () => {
  const {bin, dir, calls} = await fakeYtDlp(fail('never reached'))
  try {
    const controller = new AbortController()
    controller.abort()
    let refreshes = 0
    await assert.rejects(
      downloadWithFreshInfo(options(bin, dir), noopHandlers, {signal: controller.signal, onRefresh: () => refreshes++}),
      /cancelled/i,
    )
    assert.equal((await calls()).length <= 1, true, 'a cancel must not start a second attempt')
    assert.equal(refreshes, 0)
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})

test('the caller sees the second attempt\'s error, not the stale one', {skip: posixOnly}, async () => {
  const {bin, dir} = await fakeYtDlp(
    `case "$*" in *--load-info-json*) ${fail('stale failure')} ;; *) ${fail('fresh failure')} ;; esac`,
  )
  try {
    await assert.rejects(downloadWithFreshInfo(options(bin, dir), noopHandlers, {onRefresh: () => {}}), (error: Error) => {
      assert.match(error.message, /fresh failure/, 'the real problem is what the fresh attempt found')
      assert.equal(/stale failure/.test(error.message), false)
      return true
    })
  } finally {
    await fs.rm(dir, {recursive: true, force: true})
  }
})
