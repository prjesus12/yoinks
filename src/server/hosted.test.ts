import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before, beforeEach} from 'node:test'
import {FAKE_BYTES, fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type JobEvent, type ProbeView, type Settings, type WebServer} from './server.js'
import {AUTH_FAILURES} from './state.js'

// the fake yt-dlp is a shell script, so every download path is POSIX only
const posixOnly = process.platform === 'win32' ? 'posix only' : false

const PASSWORD = 'secret1234'
const AUTH = `Basic ${Buffer.from(`yoinks:${PASSWORD}`).toString('base64')}`
const JSON_HEADERS = {'content-type': 'application/json', authorization: AUTH}
const PROBE_LIMIT = 12
/** A public-looking address: the SSRF guard checks it without any DNS lookup. */
const PUBLIC_URL = 'http://1.1.1.1/watch?v=canned'
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'

let server: WebServer
let fake: FakeYtDlp
let port = 0
let state = ''
let downloads = ''

type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

/** A request to the running server — raw `path`, and every header under control. */
function request(
  pathname: string,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 15_000,
  }: {method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number} = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, method, headers, agent: false}, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}))
      res.on('error', reject)
    })
    const timer = setTimeout(
      () => req.destroy(new Error(`${method} ${pathname} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const text = (reply: Reply) => reply.body.toString('utf8')
const json = <T>(reply: Reply): T => JSON.parse(text(reply)) as T
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  )

/** A signed-in probe, with whatever extra headers a test needs. */
const probe = (url: string, headers: Record<string, string> = {}) =>
  request('/api/probe', {
    method: 'POST',
    headers: {...JSON_HEADERS, ...headers},
    body: JSON.stringify({url}),
  })

const download = (probeId: string, choice: number) =>
  request('/api/download', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({probeId, choice}),
  })

/** Every job route is behind the same password. */
const job = (jobId: string, suffix = '') => request(`/api/jobs/${jobId}${suffix}`, {headers: {authorization: AUTH}})

const cancelJob = (jobId: string) => request(`/api/jobs/${jobId}`, {method: 'DELETE', headers: {authorization: AUTH}})

/** The events of a server-sent-events body, in the order they arrived. */
const events = (reply: Reply): JobEvent[] =>
  text(reply)
    .split('\n\n')
    .filter(chunk => chunk.trim())
    .map(chunk => JSON.parse(chunk.replace(/^data: /, '')) as JobEvent)

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition never became true')
}

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  process.env.YOINKS_STATE_DIR = state
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  fake = await fakeYtDlp()
  server = await startWebServer({
    port: 0,
    open: false,
    outDir: downloads,
    ytdlpPath: fake.bin,
    hosted: {
      password: PASSWORD,
      maxJobs: 3,
      fileTtlMs: 60_000,
      maxPlaylist: 50,
      probeLimit: PROBE_LIMIT,
      downloadLimit: 6,
      maxProbes: 4,
      // lets the rate-limit test meter itself under its own client key
      trustProxy: true,
    },
  })
  port = Number(new URL(server.url).port)
})

beforeEach(async () => {
  // every test starts with a clean record of what reached yt-dlp
  if (fake) await fs.rm(fake.log, {force: true})
})

after(async () => {
  await server?.close()
  for (const dir of [state, downloads, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

test('GET /healthz answers without any credentials', async () => {
  const reply = await request('/healthz')
  assert.equal(reply.status, 200)
})

test('the password is required for the API, and any username works', async () => {
  const anonymous = await request('/api/settings')
  assert.equal(anonymous.status, 401)
  assert.match(String(anonymous.headers['www-authenticate']), /^Basic/)

  const wrong = await request('/api/settings', {
    headers: {authorization: `Basic ${Buffer.from('a:nope').toString('base64')}`},
  })
  assert.equal(wrong.status, 401)

  const signedIn = await request('/api/settings', {headers: {authorization: AUTH}})
  assert.equal(signedIn.status, 200)
  assert.equal(json<Settings>(signedIn).hosted, true)
})

test('another site cannot drive the API, its own origin can', async () => {
  const foreign = await request('/api/settings', {
    headers: {authorization: AUTH, origin: 'http://evil.example.com'},
  })
  assert.equal(foreign.status, 403)

  const own = await request('/api/settings', {headers: {authorization: AUTH, origin: `http://127.0.0.1:${port}`}})
  assert.equal(own.status, 200)
})

test('a link to a private address is refused before yt-dlp is ever spawned', async () => {
  const reply = await probe(METADATA_URL)
  assert.equal(reply.status, 400)
  assert.match(json<{error: string}>(reply).error, /private or local address/)
  assert.equal(await exists(fake.log), false, 'the SSRF guard must run before the child process')
})

test('POST /api/probe returns the canned video and its choices', {skip: posixOnly}, async () => {
  const reply = await probe(PUBLIC_URL)
  assert.equal(reply.status, 200)
  const view = json<ProbeView>(reply)
  assert.equal(view.kind, 'video')
  assert.equal(view.title, 'Canned Video')
  assert.deepEqual(
    view.choices.map(choice => choice.name),
    ['1080p', '720p', 'MP3', 'M4A'],
  )
})

test('a loop of probes is metered and the one past the limit gets a retry hint', async () => {
  const statuses: number[] = []
  let last: Reply | undefined
  for (let i = 0; i < PROBE_LIMIT + 1; i++) {
    // a private link is cheap: it is rejected before yt-dlp is considered
    last = await probe(METADATA_URL, {'x-forwarded-for': '203.0.113.9'})
    statuses.push(last.status)
  }
  assert.deepEqual(
    statuses.slice(0, PROBE_LIMIT),
    Array.from({length: PROBE_LIMIT}, () => 400),
  )
  assert.equal(last?.status, 429)
  assert.equal(Number(last?.headers['retry-after']) > 0, true, 'a 429 must say when to come back')
})

test('a finished download is handed back with its own bytes', {skip: posixOnly}, async () => {
  const view = json<ProbeView>(await probe(PUBLIC_URL))
  const started = await download(view.id, 0)
  assert.equal(started.status, 200)
  const {jobId} = json<{jobId: string}>(started)

  const seen = events(await job(jobId, '/events'))
  const last = seen.at(-1)
  assert.equal(last?.type, 'done', `the stream ended with ${JSON.stringify(last)}`)
  assert.equal(seen.filter(event => event.type === 'done').length, 1, 'exactly one terminal event')
  // a subscriber that shows up after the job finished gets the replay: it must
  // end on the terminal event too, and replay no stale progress tick after it
  const replayed = events(await job(jobId, '/events'))
  assert.equal(replayed.at(-1)?.type, 'done', `the replay ended with ${JSON.stringify(replayed.at(-1))}`)
  assert.equal(
    replayed.some(event => event.type === 'progress'),
    false,
    'a finished job must not replay progress ticks',
  )

  const file = await job(jobId, '/file')
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'video/mp4')
  assert.equal(text(file), FAKE_BYTES)
})

test('cancelling a hanging download removes its partial file', {skip: posixOnly}, async () => {
  await fake.hang()
  try {
    const view = json<ProbeView>(await probe(PUBLIC_URL))
    const started = await download(view.id, 0)
    assert.equal(started.status, 200)
    const {jobId} = json<{jobId: string}>(started)

    const part = `${fake.video}.part`
    await waitFor(() => exists(part))

    assert.equal((await cancelJob(jobId)).status, 204)
    await waitFor(async () => !(await exists(part)))
    assert.equal(await exists(part), false, 'the partial file survived the cancel')
  } finally {
    await fake.resume()
  }
})

test('a playlist download comes back as a zip', {skip: posixOnly}, async () => {
  const view = json<ProbeView>(await probe('http://1.1.1.1/playlist?list=PLcanned'))
  assert.equal(view.kind, 'playlist')
  const choice = view.choices.findIndex(option => option.format === 'mp3')
  assert.equal(choice >= 0, true, `no mp3 choice in ${JSON.stringify(view.choices)}`)

  const started = await download(view.id, choice)
  assert.equal(started.status, 200)
  const {jobId} = json<{jobId: string}>(started)
  const seen = events(await job(jobId, '/events'))
  assert.equal(seen.at(-1)?.type, 'done', `the stream ended with ${JSON.stringify(seen.at(-1))}`)

  const file = await job(jobId, '/file')
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'application/zip')
  assert.equal(file.body.subarray(0, 2).toString(), 'PK')
})

test('a password guessing loop is throttled instead of answered forever', async () => {
  // its own client key, so the other tests' budget is untouched
  const attacker = {'x-forwarded-for': '203.0.113.77'}
  const wrong = {...attacker, authorization: `Basic ${Buffer.from('yoinks:nope').toString('base64')}`}
  for (let attempt = 1; attempt <= AUTH_FAILURES; attempt++) {
    const reply = await request('/api/settings', {headers: wrong})
    assert.equal(reply.status, 401, `attempt ${attempt} should still be a plain 401`)
  }
  const blocked = await request('/api/settings', {headers: wrong})
  assert.equal(blocked.status, 429, `attempt ${AUTH_FAILURES + 1} must be throttled`)
  assert.equal(Number(blocked.headers['retry-after']) > 0, true, 'a 429 must say when to come back')

  // another visitor with the right password is unaffected
  const other = await request('/api/settings', {headers: {authorization: AUTH, 'x-forwarded-for': '203.0.113.78'}})
  assert.equal(other.status, 200)
})

test('the password meter is per visitor and never locks out the right password', async () => {
  const attacker = {'x-forwarded-for': '203.0.113.90'}
  const wrong = {...attacker, authorization: `Basic ${Buffer.from('yoinks:nope').toString('base64')}`}
  for (let attempt = 0; attempt <= AUTH_FAILURES; attempt++) await request('/api/settings', {headers: wrong})
  assert.equal((await request('/api/settings', {headers: wrong})).status, 429)

  // the right password still gets in — the meter blocks guesses, not access
  assert.equal((await request('/api/settings', {headers: {...attacker, authorization: AUTH}})).status, 200)
  // and another visitor starts with a clean budget
  const otherKey = '203.0.113.91'
  const otherWrong = {'x-forwarded-for': otherKey, authorization: wrong.authorization}
  assert.equal((await request('/api/settings', {headers: otherWrong})).status, 401)
  assert.equal((await request('/healthz')).status, 200)
})
