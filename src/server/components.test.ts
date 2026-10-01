import assert from 'node:assert/strict'
import test from 'node:test'
import {isNewer} from './components.js'

test('compares yt-dlp date versions, patches included', () => {
  assert.equal(isNewer('2026.09.02', '2026.08.19'), true)
  assert.equal(isNewer('2026.08.19.1', '2026.08.19'), true)
  assert.equal(isNewer('2026.08.19', '2026.08.19'), false)
  assert.equal(isNewer('2026.08.19', '2026.08.19.1'), false)
  assert.equal(isNewer('2025.12.31', '2026.01.01'), false)
})
