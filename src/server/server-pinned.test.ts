import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type ComponentsView, type WebServer} from './server.js'

// a caller that hands us a yt-dlp binary owns it — yoinks must never replace it
let fake: FakeYtDlp
let state = ''
let server: WebServer
let port = 0

type Reply = {status: number; body: string}

function request(pathname: string, method = 'GET', body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        agent: false,
        headers: payload === undefined ? {} : {'content-type': 'application/json'},
      },
      res => {
        let out = ''
        res.on('data', chunk => (out += chunk))
        res.on('end', () => resolve({status: res.statusCode ?? 0, body: out}))
      },
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const components = async () => JSON.parse((await request('/api/components')).body) as ComponentsView

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  process.env.YOINKS_STATE_DIR = state
  fake = await fakeYtDlp()
  server = await startWebServer({port: 0, open: false, outDir: state, ytdlpPath: fake.bin})
  port = Number(new URL(server.url).port)
})

after(async () => {
  await server?.close()
  for (const dir of [state, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

test('the update button refuses to replace a binary it was given', async () => {
  const updated = await request('/api/components/update', 'POST', {})
  assert.equal(updated.status, 403)
  assert.match(updated.body, /binary it was given/)

  // and the pinned binary is still the one in use, with no failure recorded
  const view = await components()
  assert.equal(view.ytdlp.managed, false)
  assert.equal(view.ytdlp.version, '2026.01.15')
  assert.equal(view.ytdlp.error, undefined)
})

test('the daily auto-update never installs over a pinned binary', async () => {
  const toggled = await request('/api/components/auto-update', 'POST', {enabled: true})
  assert.equal(toggled.status, 200)
  await new Promise(resolve => setTimeout(resolve, 500))
  const view = await components()
  assert.equal(view.ytdlp.error, undefined)
  assert.equal(view.ytdlp.managed, false)
})
