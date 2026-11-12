import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, {after, before} from 'node:test'
import {fakeYtDlp, type FakeYtDlp} from './fake-ytdlp.js'
import {startWebServer, type WebServer} from './server.js'

// The containment check in serveStatic is dead code in practice — URL parsing
// and path.normalize already clamp `..` — so these tests pin the observable
// contract instead: a traversal target is answered with the index page exactly,
// never with a file from outside the served folder.

const INDEX = '<!doctype html><title>yoinks static fixture</title>\n'
const SECRET = 'TOP-SECRET-DO-NOT-SERVE\n'

const TRAVERSALS = [
  '/../../../../secret.txt',
  '/..%2f..%2f..%2fsecret.txt',
  '/%2e%2e%2f%2e%2e%2fsecret.txt',
  '/..%5c..%5csecret.txt',
  '/assets/../../../secret.txt',
  '/../../../../etc/passwd',
]

let server: WebServer
let fake: FakeYtDlp
let port = 0
let state = ''
let downloads = ''
/** `<site>/site/` is served; `<site>/secret.txt` sits outside it. */
let site = ''

before(async () => {
  state = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-state-'))
  process.env.YOINKS_STATE_DIR = state
  downloads = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-out-'))
  fake = await fakeYtDlp()
  site = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-site-'))
  const webDir = path.join(site, 'site')
  await fs.mkdir(webDir, {recursive: true})
  await fs.writeFile(path.join(webDir, 'index.html'), INDEX)
  await fs.writeFile(path.join(site, 'secret.txt'), SECRET)
  server = await startWebServer({port: 0, open: false, outDir: downloads, ytdlpPath: fake.bin, webDir})
  port = Number(new URL(server.url).port)
})

after(async () => {
  await server?.close()
  for (const dir of [state, downloads, site, fake?.dir]) if (dir) await fs.rm(dir, {recursive: true, force: true})
})

type Reply = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

function request(pathname: string, timeoutMs = 10_000): Promise<Reply> {
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

const text = (reply: Reply) => reply.body.toString('utf8')

/** A request written straight onto the socket, so no client can rewrite the target. */
function rawRequest(line: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port})
    let data = ''
    socket.setEncoding('utf8')
    const timer = setTimeout(
      () => socket.destroy(new Error(`raw request did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    )
    socket.on('connect', () => socket.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`))
    socket.on('data', chunk => (data += chunk))
    socket.on('end', () => {
      clearTimeout(timer)
      resolve(data)
    })
    socket.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

test('every traversal target is answered with the index page, never with a file outside it', async () => {
  // the secret is really there, one level above the served folder
  assert.equal(await fs.readFile(path.join(site, 'secret.txt'), 'utf8'), SECRET)
  for (const pathname of TRAVERSALS) {
    const reply = await request(pathname)
    assert.equal(reply.status, 200, `${pathname} answered ${reply.status}`)
    assert.equal(text(reply), INDEX, `${pathname} did not answer with the index page`)
  }
})

test('a target the URL parser rejects is a bad request, not a crash', async () => {
  const response = await rawRequest('GET //[ HTTP/1.1')
  assert.match(response, /^HTTP\/1\.1 400/)
  assert.match(response, /bad request/)
})

test('malformed percent-encoding is a bad request too', async () => {
  const reply = await request('/%zz')
  assert.equal(reply.status, 400)
  assert.match(text(reply), /bad request/)
})
