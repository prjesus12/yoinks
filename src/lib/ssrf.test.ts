import assert from 'node:assert/strict'
import test from 'node:test'
import {assertPublicUrl, assertPublicUrlResolved, isPrivateHost, isPublicUrl} from './ssrf.js'

// the hosted server fetches whatever a visitor pastes, from its own network
// position — these are the addresses that must never be reachable that way
const PRIVATE_URLS = [
  'http://localhost/x',
  'http://a.b.localhost/x',
  'http://127.0.0.1/x',
  'http://127.1.2.3/x',
  'http://0.0.0.0/x',
  'http://[::1]/x',
  'http://[::]/x',
  'http://[::ffff:127.0.0.1]/x',
  'http://10.0.0.5/x',
  'http://172.16.0.1/x',
  'http://172.31.255.255/x',
  'http://192.168.1.1/x',
  'http://169.254.169.254/latest/meta-data/',
  'http://100.64.0.1/x',
  'http://[fd00::1]/x',
  'http://[fe80::1]/x',
  'http://printer.local/x',
  'http://foo.internal/x',
  'http://intranet/x',
]

const PUBLIC_URLS = [
  'https://youtu.be/dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
  'http://8.8.8.8/v.mp4',
  'http://172.32.0.1/v.mp4',
  'https://example.com:8443/a?b=c',
]

for (const url of PRIVATE_URLS) {
  test(`refuses ${url}`, () => {
    assert.equal(isPublicUrl(url), false)
    assert.throws(() => assertPublicUrl(url), /private|local|public/i)
  })
}

for (const url of PUBLIC_URLS) {
  test(`allows ${url}`, () => {
    assert.equal(isPublicUrl(url), true)
    assert.equal(assertPublicUrl(url).hostname.length > 0, true)
  })
}

test('refuses schemes that are not http(s)', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi']) {
    assert.throws(() => assertPublicUrl(url), /http/i, url)
  }
})

test('refuses a link that carries its own credentials', () => {
  assert.throws(() => assertPublicUrl('http://user:pass@example.com/x'), /username|password/i)
})

test('refuses input that is not a url at all', () => {
  assert.equal(isPublicUrl('not a url'), false)
  assert.throws(() => assertPublicUrl(''), /link|url/i)
})

test('classifies hosts by address range', () => {
  assert.equal(isPrivateHost('localhost'), true)
  assert.equal(isPrivateHost('127.0.0.1'), true)
  assert.equal(isPrivateHost('169.254.169.254'), true)
  assert.equal(isPrivateHost('172.31.0.1'), true)
  assert.equal(isPrivateHost('172.32.0.1'), false)
  assert.equal(isPrivateHost('8.8.8.8'), false)
  assert.equal(isPrivateHost('example.com'), false)
})

// the resolver is injected everywhere below, so these never touch real dns
test('refuses a name that resolves to a private address', async () => {
  await assert.rejects(
    assertPublicUrlResolved('http://127.0.0.1.nip.io/x', async () => ['127.0.0.1']),
    /private|local/i,
  )
})

test('allows a name that resolves to a public address', async () => {
  const url = await assertPublicUrlResolved('https://example.com/x', async () => ['93.184.216.34'])
  assert.equal(url.hostname, 'example.com')
})

test('never resolves an ip literal a second time', async () => {
  let asked = false
  const resolver = async () => {
    asked = true
    return []
  }
  const url = await assertPublicUrlResolved('https://8.8.8.8/x', resolver)
  assert.equal(url.hostname, '8.8.8.8')
  // a literal was already checked as written — looking it up again proves nothing
  assert.equal(asked, false)
})

test('leaves a name that does not resolve to yt-dlp', async () => {
  const url = await assertPublicUrlResolved('https://nope.invalid/x', async () => {
    throw new Error('ENOTFOUND')
  })
  // yt-dlp reports the lookup failure in its own words
  assert.equal(url.hostname, 'nope.invalid')
})
