import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sseReader} from './sse.ts'

test('returns each event once, waiting for the blank line', () => {
  const read = sseReader()
  assert.deepEqual(read('data: {"a":1}\n\ndata: {"b"'), ['{"a":1}'])
  assert.deepEqual(read('data: {"a":1}\n\ndata: {"b":2}\n\n'), ['{"b":2}'])
  assert.deepEqual(read('data: {"a":1}\n\ndata: {"b":2}\n\n'), [])
})
