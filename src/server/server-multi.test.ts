import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type JobEvent, type ProbeView, type Settings, type WebServer} from './server.js'

// regression: close() used to be guarded by a module-wide flag, so closing a
// second server in the same process was a silent no-op and left it listening.
// This file is deliberately alone and every request has a timeout: a regression
// must fail, not hang the suite.

let fake: FakeYtDlp
let state = ''
let downloads = ''

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  fake = await fakeYtDlp()
  process.env.YOINKS_STATE_DIR = state
})

after(async () => {
  for (const dir of [state, downloads, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

function request(port: number, pathname: string, timeoutMs = 5000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, agent: false}, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)}))
      res.on('error', reject)
    })
    const timer = setTimeout(
      () => req.destroy(new Error(`GET ${pathname} did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    )
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
}

const portOf = (server: WebServer) => Number(new URL(server.url).port)
const refused = (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED'

const start = () => startWebServer({port: 0, open: false, outDir: downloads, ytdlpPath: fake.bin})

test('two servers in one process can both be closed', {timeout: 60_000}, async () => {
  const first = await start()
  const second = await start()
  const firstPort = portOf(first)
  const secondPort = portOf(second)
  try {
    assert.equal((await request(firstPort, '/api/settings')).status, 200)
    assert.equal((await request(secondPort, '/api/settings')).status, 200)

    await first.close()
    await assert.rejects(request(firstPort, '/api/settings'), refused, 'the first port must refuse connections')
    // closing the first server must not have stopped the second one
    assert.equal((await request(secondPort, '/api/settings')).status, 200)

    // the bug: this used to return immediately without closing anything
    await second.close()
    await assert.rejects(request(secondPort, '/api/settings'), refused, 'the second port must refuse connections')
  } finally {
    // a second close is a no-op, so this can never mask the assertions above
    await first.close()
    await second.close()
  }
})

const PASSWORD = 'secret1234'
const AUTH = `Basic ${Buffer.from(`yoinks:${PASSWORD}`).toString('base64')}`
const JSON_AUTH = {'content-type': 'application/json', authorization: AUTH}
/** A public address: the SSRF guard checks it without touching DNS. */
const PUBLIC_URL = 'http://1.1.1.1/watch?v=canned'

/** A request to the given server, with every header under control. */
function call(
  port: number,
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

const bodyJson = <T>(reply: Reply): T => JSON.parse(reply.body.toString('utf8')) as T

/** The events of a job, once it has finished — retried while it is still running. */
async function finishedEvents(port: number, jobId: string, timeoutMs = 15_000): Promise<JobEvent[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const reply = await call(port, `/api/jobs/${jobId}/events`, {headers: {authorization: AUTH}, timeoutMs: 500})
      assert.equal(reply.status, 200)
      return reply.body
        .toString('utf8')
        .split('\n\n')
        .filter(chunk => chunk.trim())
        .map(chunk => JSON.parse(chunk.replace(/^data: /, '')) as JobEvent)
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
  }
}

test('a server started after another one closed still answers on its own port', {timeout: 60_000}, async () => {
  const first = await start()
  await first.close()
  const second = await start()
  try {
    const reply = await request(portOf(second), '/api/settings')
    assert.equal(reply.status, 200)
    assert.equal((JSON.parse(reply.body.toString('utf8')) as Settings).hosted, false)
  } finally {
    await second.close()
  }
})

// the module-level singletons used to be shared: starting the hosted server
// turned the local one into a password-protected public server, and closing
// the local one emptied the hosted one's probes and jobs.
test('a hosted server never reshapes a local one, and neither close touches the other', {timeout: 60_000}, async () => {
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-local-'))
  const hostedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-hosted-'))
  const local = await startWebServer({port: 0, open: false, outDir: localDir, ytdlpPath: fake.bin})
  const hosted = await startWebServer({
    port: 0,
    open: false,
    outDir: hostedDir,
    ytdlpPath: fake.bin,
    hosted: {password: PASSWORD, maxJobs: 3, fileTtlMs: 60_000, maxPlaylist: 50},
  })
  const localPort = portOf(local)
  const hostedPort = portOf(hosted)
  try {
    // both at the same time: the local one stays open and stays local
    assert.equal((await call(hostedPort, '/api/settings')).status, 401, 'the hosted server asks for the password')
    const localSettings = await call(localPort, '/api/settings')
    assert.equal(localSettings.status, 200, 'the local server must not inherit the hosted password')
    assert.equal(bodyJson<Settings>(localSettings).hosted, false)
    assert.equal(bodyJson<Settings>(localSettings).outDir, localDir)

    const hostedSettings = await call(hostedPort, '/api/settings', {headers: {authorization: AUTH}})
    assert.equal(hostedSettings.status, 200)
    assert.equal(bodyJson<Settings>(hostedSettings).hosted, true)
    assert.equal(bodyJson<Settings>(hostedSettings).outDir, hostedDir)

    // probe both, and leave a finished download on the hosted one
    const localProbe = await call(localPort, '/api/probe', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({url: PUBLIC_URL}),
    })
    assert.equal(localProbe.status, 200)
    const hostedProbe = await call(hostedPort, '/api/probe', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({url: PUBLIC_URL}),
    })
    assert.equal(hostedProbe.status, 200)
    const hostedProbeId = bodyJson<ProbeView>(hostedProbe).id

    const hostedDownload = await call(hostedPort, '/api/download', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({probeId: hostedProbeId, choice: 0}),
    })
    assert.equal(hostedDownload.status, 200)
    const jobId = bodyJson<{jobId: string}>(hostedDownload).jobId
    assert.ok((await finishedEvents(hostedPort, jobId)).some(event => event.type === 'done'))

    // closing the local server leaves the hosted one's port, probes and jobs alone
    await local.close()
    await assert.rejects(request(localPort, '/api/settings'), refused, 'the local port must refuse connections')
    assert.equal((await call(hostedPort, '/api/settings', {headers: {authorization: AUTH}})).status, 200)
    assert.equal((await call(hostedPort, `/api/jobs/${jobId}/events`, {headers: {authorization: AUTH}})).status, 200)
    const reuse = await call(hostedPort, '/api/download', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({probeId: hostedProbeId, choice: 0}),
    })
    assert.equal(reuse.status, 200, 'the hosted server must keep the probes it was already serving')
    const freshProbe = await call(hostedPort, '/api/probe', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({url: PUBLIC_URL}),
    })
    assert.equal(freshProbe.status, 200)
    // and it is still the password-protected one
    assert.equal((await call(hostedPort, '/api/settings')).status, 401)
  } finally {
    await local.close()
    await hosted.close()
    for (const dir of [localDir, hostedDir]) await fs.rm(dir, {recursive: true, force: true})
  }
})
