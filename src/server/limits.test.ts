import assert from 'node:assert/strict'
import test from 'node:test'
import {sweep} from './jobs.js'
import {createRateLimiter} from './limits.js'
import {createServerState} from './state.js'

test('allows up to the limit inside one window, then blocks with a retry hint', () => {
  const limiter = createRateLimiter({limit: 3, windowMs: 1000})
  assert.equal(limiter.take('a', 0).allowed, true)
  assert.equal(limiter.take('a', 100).allowed, true)
  assert.equal(limiter.take('a', 200).allowed, true)
  const blocked = limiter.take('a', 300)
  assert.equal(blocked.allowed, false)
  // the slot comes back when the oldest hit leaves the window
  assert.equal(blocked.retryAfterMs, 700)
})

test('frees a slot once the window slides past the oldest hit', () => {
  const limiter = createRateLimiter({limit: 2, windowMs: 1000})
  limiter.take('a', 0)
  limiter.take('a', 10)
  assert.equal(limiter.take('a', 500).allowed, false)
  assert.equal(limiter.take('a', 1000).allowed, true)
  assert.equal(limiter.take('a', 1005).allowed, false)
  assert.equal(limiter.take('a', 1011).allowed, true)
})

test('keys are independent', () => {
  const limiter = createRateLimiter({limit: 1, windowMs: 1000})
  assert.equal(limiter.take('a', 0).allowed, true)
  assert.equal(limiter.take('b', 0).allowed, true)
  assert.equal(limiter.take('a', 0).allowed, false)
})

test('forgets keys that have been idle for a whole window', () => {
  const limiter = createRateLimiter({limit: 1, windowMs: 100})
  limiter.take('a', 0)
  limiter.take('b', 0)
  assert.equal(limiter.size(), 2)
  limiter.prune(50)
  assert.equal(limiter.size(), 2)
  limiter.prune(100)
  assert.equal(limiter.size(), 0)
})

test('the sweep forgets the password meter, like the request meters', () => {
  // the password meter takes unauthenticated traffic, so it grows fastest
  const state = createServerState()
  for (let i = 0; i < 3; i++) state.authLimiter.take(`203.0.113.${i}`, 0)
  for (let i = 0; i < 3; i++) state.probeLimiter.take(`203.0.113.${i}`, 0)
  sweep(state)
  assert.equal(state.probeLimiter.size(), 0, 'the probe meter must be pruned')
  assert.equal(state.authLimiter.size(), 0, 'the password meter must be pruned too')
})
