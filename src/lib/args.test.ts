import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('parses download presets and an output folder', () => {
  assert.deepEqual(parseArgs(['--mp3', '-o', '~/Music', 'https://example.com/list']), {
    help: false,
    version: false,
    preset: 'mp3',
    outDir: '~/Music',
    initialUrl: 'https://example.com/list',
  })
  assert.equal(parseArgs(['--m4a']).preset, 'm4a')
  assert.equal(parseArgs(['--best', '--out=videos']).outDir, 'videos')
  assert.equal(parseArgs(['--mp3', '--mp3']).preset, 'mp3')
})

test('rejects conflicting presets and a missing output folder', () => {
  assert.match(parseArgs(['--mp3', '--best']).error ?? '', /pick one/)
  assert.match(parseArgs(['--out']).error ?? '', /needs a folder/)
  assert.match(parseArgs(['--out=']).error ?? '', /needs a folder/)
})

test('parses the web server options', () => {
  assert.deepEqual(parseArgs(['--web', '--port', '8080', '--no-open']), {
    help: false,
    version: false,
    web: true,
    port: 8080,
    noOpen: true,
    initialUrl: undefined,
  })
  assert.equal(parseArgs(['--web', '--port=3000']).port, 3000)
  assert.match(parseArgs(['--port', 'abc']).error ?? '', /--port needs/)
  assert.match(parseArgs(['--port=70000']).error ?? '', /--port needs/)
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
