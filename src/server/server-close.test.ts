import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type ProbeView, type Settings, type WebServer} from './server.js'

// the fake yt-dlp is a shell script, so the download half of this is POSIX only
const posixOnly = process.platform === 'win32' ? 'posix only' : false

/** A public-looking address: the hosted SSRF guard checks it without any DNS. */
const PUBLIC_URL = 'http://1.1.1.1/watch?v=canned'

let fake: FakeYtDlp
let state = ''
let downloads = ''
/** The TMPDIR the server gets: probe metadata and job scratch folders land here. */
let sandbox = ''

before(async () => {
  // created before TMPDIR moves, so they stay outside the sandbox
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  fake = await fakeYtDlp()
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-tmpdir-'))
  process.env.YOINKS_STATE_DIR = state
  process.env.TMPDIR = sandbox
})

after(async () => {
  delete process.env.TMPDIR
  for (const dir of [state, downloads, sandbox, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

/** A request to one of the servers — `agent: false` and a timeout, so it fails instead of hanging. */
function request(
  port: number,
  pathname: string,
  {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10_000,
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

const post = (port: number, pathname: string, payload: unknown) =>
  request(port, pathname, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(payload),
  })

const start = () => startWebServer({port: 0, open: false, outDir: downloads, ytdlpPath: fake.bin})
const portOf = (server: WebServer) => Number(new URL(server.url).port)
const refused = (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED'

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('condition never became true')
}

/**
 * An event stream held open. `ready` resolves once the server has answered the
 * headers, so a test knows it is subscribed before it closes the server.
 */
function openEventStream(port: number, pathname: string, timeoutMs = 15_000) {
  let ready = () => {}
  let rejectReady = (_error: Error) => {}
  let finish = (_reply: Reply) => {}
  let fail = (_error: Error) => {}
  let subscribed = false
  // never leave this pending: a failed subscribe must fail the test, not hang it
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve
    rejectReady = reject
  })
  const body = new Promise<Reply>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const req = http.request({host: '127.0.0.1', port, path: pathname, agent: false}, res => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => finish({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}))
    res.on('error', fail)
    subscribed = true
    ready()
  })
  const timer = setTimeout(() => req.destroy(new Error(`${pathname} stayed open for ${timeoutMs}ms`)), timeoutMs)
  req.on('close', () => {
    clearTimeout(timer)
    if (!subscribed) rejectReady(new Error(`${pathname} closed before the server answered`))
  })
  req.on('error', error => {
    fail(error)
    rejectReady(error)
  })
  req.end()
  return {subscribed: readyPromise, body}
}

test('three start/close cycles leave one signal listener each while running and none after', async () => {
  // whatever the test runner itself listens to stays untouched
  const baseline = {int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')}
  for (let cycle = 1; cycle <= 3; cycle++) {
    const server = await start()
    assert.equal(process.listenerCount('SIGINT'), baseline.int + 1, `cycle ${cycle}: one SIGINT listener`)
    assert.equal(process.listenerCount('SIGTERM'), baseline.term + 1, `cycle ${cycle}: one SIGTERM listener`)
    assert.equal((await request(portOf(server), '/api/settings')).status, 200)

    await server.close()
    assert.equal(process.listenerCount('SIGINT'), baseline.int, `cycle ${cycle}: SIGINT listener removed`)
    assert.equal(process.listenerCount('SIGTERM'), baseline.term, `cycle ${cycle}: SIGTERM listener removed`)

    // closing twice must not leak a listener either
    await server.close()
    assert.equal(process.listenerCount('SIGINT'), baseline.int, `cycle ${cycle}: second close kept SIGINT clean`)
    assert.equal(process.listenerCount('SIGTERM'), baseline.term, `cycle ${cycle}: second close kept SIGTERM clean`)
  }
})

test('a closed server refuses new connections while a later one still answers', async () => {
  const first = await start()
  const firstPort = portOf(first)
  assert.equal((await request(firstPort, '/api/settings')).status, 200)
  await first.close()
  await assert.rejects(request(firstPort, '/api/settings'), refused, 'the closed port must refuse connections')

  const second = await start()
  try {
    const reply = await request(portOf(second), '/api/settings')
    assert.equal(reply.status, 200)
    assert.equal(json<Settings>(reply).hosted, false)
  } finally {
    await second.close()
  }
})

test('close() ends an open event stream, aborts the download and empties TMPDIR', {skip: posixOnly}, async () => {
  const server = await startWebServer({
    port: 0,
    open: false,
    outDir: downloads,
    ytdlpPath: fake.bin,
    hosted: {maxJobs: 3, fileTtlMs: 60_000, maxPlaylist: 50},
  })
  const port = portOf(server)
  await fake.hang()
  try {
    const probe = json<ProbeView>(await post(port, '/api/probe', {url: PUBLIC_URL}))
    const {jobId} = json<{jobId: string}>(await post(port, '/api/download', {probeId: probe.id, choice: 0}))
    const part = `${fake.video}.part`
    await new Promise(resolve => setTimeout(resolve, 2000))
    await waitFor(() => exists(part))

    // the probe's metadata file and the job's scratch folder both live there
    const used = await fs.readdir(sandbox)
    assert.equal(used.length > 0, true, `the server wrote nothing to TMPDIR: ${JSON.stringify(used)}`)

    const stream = openEventStream(port, `/api/jobs/${jobId}/events`)
    await stream.subscribed
    await server.close()

    // close ends the stream — and the download never got to report a result
    const ended = await stream.body
    assert.equal(ended.status, 200)
    assert.equal(text(ended).includes('"type":"done"'), false, 'the download was supposed to be still running')

    // the aborted download cleans up its own partial file
    await waitFor(async () => !(await exists(part)))
    assert.equal(await exists(part), false, 'the partial file survived the close')

    // nothing of the server's is left behind in TMPDIR
    assert.deepEqual(await fs.readdir(sandbox), [])
  } finally {
    await fake.resume()
  }
})

// `--test-force-exit` makes a passing run exit even with a socket still open,
// so a leak after close() would otherwise go unnoticed.
after(() => {
  const listening = process.getActiveResourcesInfo().filter(resource => resource === 'TCPServerWrap')
  assert.deepEqual(listening, [], 'a test left a server listening: --test-force-exit would hide this')
})
