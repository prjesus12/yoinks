import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type JobEvent, type ProbeView, type Settings, type WebServer} from './server.js'

// the fake yt-dlp is a shell script, so every download path is POSIX only
const posixOnly = process.platform === 'win32' ? 'posix only' : false

let server: WebServer
let fake: FakeYtDlp
let port = 0
let state = ''
let downloads = ''
/** Stands in for the built web app: `<site>/site/` is served, `<site>/secret.txt` is not. */
let site = ''
let webDir = ''

const INDEX = '<!doctype html><title>yoinks test app</title><div id="root"></div>\n'
const ASSET = 'console.log("yoinks test asset")\n'
const SECRET = 'TOP-SECRET-DO-NOT-SERVE\n'

type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

/** A request to the running server — raw `path`, so traversal attempts survive. */
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

const post = (pathname: string, payload: unknown) =>
  request(pathname, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload),
  })

/** The events of a server-sent-events body, in the order they arrived. */
const events = (reply: Reply): JobEvent[] =>
  text(reply)
    .split('\n\n')
    .filter(chunk => chunk.trim())
    .map(chunk => JSON.parse(chunk.replace(/^data: /, '')) as JobEvent)

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  process.env.YOINKS_STATE_DIR = state
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  fake = await fakeYtDlp()
  // a stand-in for the built web app, with a file just outside it to reach for
  site = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-site-'))
  webDir = path.join(site, 'site')
  await fs.mkdir(path.join(webDir, 'assets'), {recursive: true})
  await fs.writeFile(path.join(webDir, 'index.html'), INDEX)
  await fs.writeFile(path.join(webDir, 'assets', 'app.js'), ASSET)
  await fs.writeFile(path.join(site, 'secret.txt'), SECRET)
  server = await startWebServer({port: 0, open: false, outDir: downloads, ytdlpPath: fake.bin, webDir})
  port = Number(new URL(server.url).port)
})

after(async () => {
  await server?.close()
  for (const dir of [state, downloads, site, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

test('GET /api/settings reports a local server', async () => {
  const reply = await request('/api/settings')
  assert.equal(reply.status, 200)
  const settings = json<Settings>(reply)
  assert.equal(settings.hosted, false)
})

test('a foreign Host header is refused, so DNS rebinding gets nowhere', async () => {
  const reply = await request('/api/settings', {headers: {host: 'rebind.example.com'}})
  assert.equal(reply.status, 403)
  assert.match(json<{error: string}>(reply).error, /forbidden host/)
})

test('POST /api/probe without a JSON content type is refused', async () => {
  const reply = await request('/api/probe', {method: 'POST'})
  assert.equal(reply.status, 415)
})

test('unknown API paths are 404 and non-GET page requests are 405', async () => {
  assert.equal((await request('/api/does-not-exist')).status, 404)
  assert.equal((await request('/', {method: 'PUT'})).status, 405)
})

test('GET / serves the single-page app', async () => {
  const reply = await request('/')
  assert.equal(reply.status, 200)
  assert.equal(String(reply.headers['content-type']).startsWith('text/html'), true)
  assert.equal(text(reply), INDEX)
})

test('GET /assets/app.js is served as an immutable, hashed asset', async () => {
  const reply = await request('/assets/app.js')
  assert.equal(reply.status, 200)
  assert.match(String(reply.headers['content-type']), /^text\/javascript/)
  assert.match(String(reply.headers['cache-control']), /immutable/)
  assert.equal(text(reply), ASSET)
})

test('a client-side route falls back to the single-page app', async () => {
  const reply = await request('/some/client/route')
  assert.equal(reply.status, 200)
  assert.equal(text(reply), INDEX)
})

test('a path-traversal attempt never reaches a file outside the web folder', async () => {
  // the secret really is on disk, one level above the folder being served
  assert.equal(await exists(path.join(site, 'secret.txt')), true)
  const attempts = [
    '/../../../etc/passwd',
    '/../../../secret.txt',
    '/..%2f..%2fsecret.txt',
    '/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/..%5c..%5csecret.txt',
    '//..%2f..%2fsecret.txt',
  ]
  for (const pathname of attempts) {
    const reply = await request(pathname)
    assert.equal(text(reply).includes('root:'), false, `${pathname} served the passwd file`)
    assert.equal(text(reply).includes(SECRET.trim()), false, `${pathname} served the secret`)
  }
})

test('POST /api/probe returns the choices the fake yt-dlp offers', {skip: posixOnly}, async () => {
  const reply = await post('/api/probe', {url: 'https://example.com/watch?v=canned'})
  assert.equal(reply.status, 200)
  const probe = json<ProbeView>(reply)
  assert.equal(probe.kind, 'video')
  assert.equal(probe.title, 'Canned Video')
  assert.equal(probe.author, 'Canned Uploader')
  assert.deepEqual(
    probe.choices.map(choice => choice.name),
    ['1080p', '720p', 'MP3', 'M4A'],
  )
  // the probe really went through the fake binary
  assert.match(await fs.readFile(fake.log, 'utf8'), /-J/)
})

test(
  'a download replays its events, writes the file, and can be dropped once finished',
  {skip: posixOnly},
  async () => {
    const probe = json<ProbeView>(await post('/api/probe', {url: 'https://example.com/watch?v=canned'}))
    const started = await post('/api/download', {probeId: probe.id, choice: 0})
    assert.equal(started.status, 200)
    const {jobId} = json<{jobId: string}>(started)
    assert.ok(jobId)

    const stream = await request(`/api/jobs/${jobId}/events`)
    assert.equal(stream.status, 200)
    assert.match(String(stream.headers['content-type']), /text\/event-stream/)
    const seen = events(stream)
    const last = seen.at(-1)
    assert.equal(last?.type, 'done', `the stream ended with ${JSON.stringify(last)}`)
    assert.equal(last?.type === 'done' && last.path.endsWith('video.mp4'), true)
    // a subscriber that shows up after the job finished gets the replay, which
    // must also end on the terminal event — never a stale progress tick
    const replayed = events(await request(`/api/jobs/${jobId}/events`))
    assert.equal(replayed.at(-1)?.type, 'done', `the replay ended with ${JSON.stringify(replayed.at(-1))}`)
    assert.equal(
      replayed.some(event => event.type === 'progress'),
      false,
      'a finished job must not replay progress ticks',
    )
    // the fake wrote its bytes where the server then looks for the result
    assert.equal(await exists(fake.video), true)

    // the job already finished, so this is the "already gone" path: dropping it
    // is idempotent and its id stops resolving. A real cancel — one that aborts a
    // running download and cleans up its partial files — lives in hosted.test.ts.
    const dropped = await request(`/api/jobs/${jobId}`, {method: 'DELETE'})
    assert.equal(dropped.status, 204)
    assert.equal((await request(`/api/jobs/${jobId}`, {method: 'DELETE'})).status, 204)
    assert.equal((await request(`/api/jobs/${jobId}/events`)).status, 404, 'a dropped job must stop resolving')
  },
)
