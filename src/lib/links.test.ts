import assert from 'node:assert/strict'
import test from 'node:test'
import {eachLimit, splitLinks} from './links.js'

test('splits pasted text into links', () => {
  assert.deepEqual(splitLinks('https://youtu.be/a\nhttps://x.com/b/status/1  http://vimeo.com/2'), [
    'https://youtu.be/a',
    'https://x.com/b/status/1',
    'http://vimeo.com/2',
  ])
})

test('keeps a single link as one', () => {
  assert.deepEqual(splitLinks('  https://youtu.be/a  '), ['https://youtu.be/a'])
})

test('ignores words and duplicates', () => {
  assert.deepEqual(splitLinks('look https://youtu.be/a and https://youtu.be/a'), ['https://youtu.be/a'])
  assert.deepEqual(splitLinks('not a link'), [])
})

test('runs at most `limit` at a time, all of them', async () => {
  let running = 0
  let peak = 0
  const done: number[] = []
  await eachLimit([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    running++
    peak = Math.max(peak, running)
    await new Promise(r => setTimeout(r, 5))
    running--
    done.push(n)
  })
  assert.equal(peak, 3)
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7])
})

test('one failure never stops the rest', async () => {
  const done: number[] = []
  await eachLimit([1, 2, 3], 1, async n => {
    if (n === 2) throw new Error('boom')
    done.push(n)
  })
  assert.deepEqual(done, [1, 3])
})
