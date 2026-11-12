import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type WebServer} from './server.js'

// `webDir` is module state, like the rest of the server's configuration — a
// server that does not ask for one must not serve whatever the previous server
// in this process was pointed at.
const INDEX = '<!doctype html><title>FIRST SERVER</title>\n'

let fake: FakeYtDlp
let state = ''
let site = ''

function body(server: WebServer, pathname = '/'): Promise<{status: number; body: string}> {
  const port = Number(new URL(server.url).port)
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: pathname, agent: false}, res => {
      let out = ''
      res.on('data', chunk => (out += chunk))
      res.on('end', () => resolve({status: res.statusCode ?? 0, body: out}))
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error(`${pathname} timed out`)))
    req.end()
  })
}

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  process.env.YOINKS_STATE_DIR = state
  fake = await fakeYtDlp()
  site = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-site-'))
  await fs.writeFile(path.join(site, 'index.html'), INDEX)
})

after(async () => {
  for (const dir of [state, site, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

test('a server without webDir does not inherit the previous server web folder', async () => {
  const first = await startWebServer({port: 0, open: false, outDir: state, ytdlpPath: fake.bin, webDir: site})
  try {
    assert.match((await body(first)).body, /FIRST SERVER/)
  } finally {
    await first.close()
  }

  const second = await startWebServer({port: 0, open: false, outDir: state, ytdlpPath: fake.bin})
  try {
    const reply = await body(second)
    assert.equal(reply.body.includes('FIRST SERVER'), false, 'the second server served the first one’s folder')
    // from source the built app is absent, so this is the "not built" 404
    assert.notEqual(reply.status, 500)
  } finally {
    await second.close()
  }
})
