import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatBytes,
  formatDuration,
  formatEta,
  formatSpeed,
  shortenPath,
  tildePath,
  truncate,
  wrapText,
} from './format.js'

const HOME = '/Users/someone'

test('a path under the home directory wears a tilde', () => {
  assert.equal(tildePath(`${HOME}/Downloads/a.mp4`, HOME), '~/Downloads/a.mp4')
  assert.equal(tildePath(`${HOME}/Music`, HOME), '~/Music')
})

test('a path outside the home directory is left alone', () => {
  assert.equal(tildePath('/srv/media/a.mp4', HOME), '/srv/media/a.mp4')
  assert.equal(tildePath('/Users/someoneelse/a.mp4', HOME), '/Users/someoneelse/a.mp4')
})

test('the home directory itself shortens to a bare tilde', () => {
  assert.equal(tildePath(HOME, HOME), '~')
})

test('a short path is not truncated', () => {
  assert.equal(shortenPath(`${HOME}/Downloads/a.mp4`, HOME), '~/Downloads/a.mp4')
})

test('a long path keeps its head and its extension', () => {
  const long = `${HOME}/Downloads/Some Very Long Album Name/01 - A Track With A Long Name.mp4`
  const short = shortenPath(long, HOME, 40)
  assert.equal(short.length <= 40, true, `got ${short.length} chars: ${short}`)
  assert.equal(short.startsWith('~/Downloads/'), true, 'it should still be recognisable')
  assert.equal(short.endsWith('.mp4'), true, 'the extension is how you tell what it is')
  assert.match(short, /…/)
})

test('a long path with no extension is still truncated', () => {
  const short = shortenPath(`${HOME}/Downloads/no-extension-at-all-here`, HOME, 20)
  assert.equal(short.length <= 20, true)
  assert.match(short, /…$/)
})

test('a Windows path under the home directory wears a tilde', () => {
  // the separator is checked explicitly because this module cannot import node:path
  assert.equal(tildePath('C:\\Users\\someone\\a.mp4', 'C:\\Users\\someone'), '~\\a.mp4')
  assert.equal(tildePath('C:\\Users\\someone', 'C:\\Users\\someone'), '~')
  assert.equal(tildePath('C:\\Users\\someoneelse\\a.mp4', 'C:\\Users\\someone'), 'C:\\Users\\someoneelse\\a.mp4')
})

test('a home directory with a trailing separator still shortens', () => {
  assert.equal(tildePath(`${HOME}/a.mp4`, `${HOME}/`), '~/a.mp4')
  // the home directory with a separator keeps it — only the exact home is a bare tilde
  assert.equal(tildePath(`${HOME}/`, `${HOME}/`), '~/')
})

test('shortenPath never invents a tilde for a sibling directory', () => {
  assert.equal(shortenPath('/Users/someoneelse/a.mp4', HOME), '/Users/someoneelse/a.mp4')
  assert.equal(shortenPath(`${HOME}/Downloads/a.mp4`, HOME), '~/Downloads/a.mp4')
})

// ---------------------------------------------------------------------------
// everything else in this module is what the user actually reads

test('bytes are human, and zero says nothing', () => {
  assert.equal(formatBytes(0), '')
  assert.equal(formatBytes(-5), '')
  assert.equal(formatBytes(Number.NaN), '')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(10 * 1024), '10 KB', 'two digits drop the decimal')
})

test('durations pad the minutes once there is an hour', () => {
  assert.equal(formatDuration(0), '')
  assert.equal(formatDuration(-1), '')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3700), '1:01:40', 'minutes are padded inside an hour')
  assert.equal(formatDuration(59), '0:59')
})

test('truncate only touches what is too long', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('hello wor', 10), 'hello wor')
  // max-1 characters plus the ellipsis: the result is never longer than max
  assert.equal(truncate('hello world', 10), 'hello wor…')
  assert.equal(truncate('hello world', 10).length, 10)
})

test('wrapText breaks on words and keeps them whole', () => {
  assert.deepEqual(wrapText('aaaa bbb cc', 7), ['aaaa', 'bbb cc'], 'greedy: bbb and cc fit together')
  assert.deepEqual(wrapText('one', 10), ['one'])
  assert.deepEqual(wrapText('', 10), [])
  // no line keeps a trailing space, which is what makes the block look centered
  assert.equal(wrapText('aaaa bbb cc', 7).some(line => line.endsWith(' ')), false)
})

test('speed and eta stay quiet when there is nothing to say', () => {
  assert.equal(formatSpeed(0), '')
  assert.equal(formatSpeed(-1), '')
  assert.equal(formatSpeed(1536), '1.5 KB/s')
  assert.equal(formatEta(0), '')
  assert.equal(formatEta(-1), '')
  assert.equal(formatEta(90), '1:30')
})
