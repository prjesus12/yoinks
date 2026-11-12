import assert from 'node:assert/strict'
import test from 'node:test'
import {hostedConfigFromEnv, hostedOptionsFromFlags} from './hosted-config.js'

const PASSWORD = 'a-long-enough-password'

test('refuses to start without a password', () => {
  assert.throws(() => hostedConfigFromEnv({}), /YOINKS_PASSWORD/)
})

test('treats a blank password as missing', () => {
  assert.throws(() => hostedConfigFromEnv({YOINKS_PASSWORD: '   '}), /YOINKS_PASSWORD/)
})

test('accepts an explicit opt-out for a deliberately public server', () => {
  const config = hostedConfigFromEnv({YOINKS_ALLOW_PUBLIC: '1'})
  assert.equal(config.password, undefined)
  assert.equal(config.allowPublic, true)
  assert.equal(
    config.warnings.some(warning => /no password/i.test(warning)),
    true,
  )
})

test('defaults every limit when the environment is bare', () => {
  const config = hostedConfigFromEnv({YOINKS_PASSWORD: PASSWORD})
  assert.equal(config.password, PASSWORD)
  assert.equal(config.port, 4455)
  assert.equal(config.maxJobs, 3)
  assert.equal(config.fileTtlMs, 15 * 60 * 1000)
  assert.equal(config.maxPlaylist, 50)
  assert.equal(config.probeLimit, 12)
  assert.equal(config.downloadLimit, 6)
  assert.equal(config.maxProbes, 4)
  assert.equal(config.trustProxy, false)
  assert.deepEqual(config.warnings, [])
})

test('reads overrides and ignores junk', () => {
  const config = hostedConfigFromEnv({
    YOINKS_PASSWORD: PASSWORD,
    YOINKS_MAX_JOBS: '5',
    YOINKS_FILE_TTL: '30',
    YOINKS_MAX_PLAYLIST: '10',
    YOINKS_TRUST_PROXY: '1',
    YOINKS_PROBE_LIMIT: 'nope',
  })
  assert.equal(config.maxJobs, 5)
  assert.equal(config.fileTtlMs, 30 * 60 * 1000)
  assert.equal(config.maxPlaylist, 10)
  assert.equal(config.trustProxy, true)
  assert.equal(config.probeLimit, 12)
})

test('warns about a weak password but still starts', () => {
  const config = hostedConfigFromEnv({YOINKS_PASSWORD: 'abc'})
  assert.equal(config.password, 'abc')
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0]!, /short/i)
})

test('passes the optional files through untouched', () => {
  const config = hostedConfigFromEnv({
    YOINKS_PASSWORD: PASSWORD,
    YOINKS_COOKIES: '/srv/yoinks/cookies.txt',
    YOINKS_PROXY: 'http://user:pass@host:1080',
  })
  assert.equal(config.cookiesFile, '/srv/yoinks/cookies.txt')
  assert.equal(config.proxy, 'http://user:pass@host:1080')
})

test('the flags path keeps the same defaults as the environment path', () => {
  const options = hostedOptionsFromFlags({password: 'a-long-enough-password'})
  assert.equal(options.maxJobs, 3)
  assert.equal(options.fileTtlMs, 15 * 60 * 1000)
  assert.equal(options.maxPlaylist, 50)
  assert.equal(options.probeLimit, 12)
  assert.equal(options.downloadLimit, 6)
  assert.equal(options.maxProbes, 4)
  // a flag path never trusts a proxy header it cannot see
  assert.equal(options.trustProxy, false)
})
