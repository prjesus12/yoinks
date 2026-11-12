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

test('parses the options that expose the web server', () => {
  const parsed = parseArgs(['--web', '--host', '0.0.0.0', '--password', 'hunter2hunter2', '--max-jobs', '5'])
  assert.deepEqual(parsed, {
    help: false,
    version: false,
    web: true,
    host: '0.0.0.0',
    password: 'hunter2hunter2',
    maxJobs: 5,
    initialUrl: undefined,
  })
  assert.equal(parseArgs(['--web', '--host=::', '--allow-public']).host, '::')
  assert.equal(parseArgs(['--web', '--max-jobs=2']).maxJobs, 2)
  assert.match(parseArgs(['--web', '--max-jobs', '0']).error ?? '', /--max-jobs needs/)
  assert.match(parseArgs(['--web', '--password']).error ?? '', /--password needs/)
})

test('refuses to expose the web server without a password', () => {
  // the same rule the hosted entry enforces: an open downloader gets abused fast
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'my-box.local']) {
    assert.match(parseArgs(['--web', '--host', host]).error ?? '', /exposes yoinks to your network/, host)
  }
  // an explicit opt-out is allowed, and so is a password
  assert.equal(parseArgs(['--web', '--host', '0.0.0.0', '--allow-public']).error, undefined)
  assert.equal(parseArgs(['--web', '--host', '0.0.0.0', '--password', 'hunter2hunter2']).error, undefined)
})

test('a loopback bind needs no password', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.equal(parseArgs(['--web', '--host', host]).error, undefined, host)
  }
})

test('the exposing options only make sense with --web', () => {
  for (const argv of [
    ['--host', '127.0.0.1'],
    ['--password', 'hunter2hunter2'],
    ['--max-jobs', '2'],
    ['--allow-public'],
  ]) {
    assert.match(parseArgs(argv).error ?? '', /only work with --web/, argv.join(' '))
  }
})

test('every literal non-loopback host is refused without a password', () => {
  // trailing dots, padding, brackets and bare names all count as exposure
  for (const host of ['0.0.0.0', '0.0.0.0.', '::', '[::]', ':: ', ' [::]', '10.0.0.5', '*', '::ffff:127.0.0.1']) {
    assert.match(parseArgs(['--web', '--host', host]).error ?? '', /exposes yoinks to your network/, host)
  }
  for (const arg of ['--host=0.0.0.0', '--host=::']) {
    assert.match(parseArgs(['--web', arg]).error ?? '', /exposes yoinks to your network/, arg)
  }
})

test('a name that merely starts with 127. is not loopback', () => {
  // the check is over literals: a name can resolve anywhere
  for (const host of ['127.0.0.1.nip.io', '127.0.0.1.', '127.0.0.2', '127.1']) {
    assert.match(parseArgs(['--web', '--host', host]).error ?? '', /exposes yoinks to your network/, host)
  }
})

test('a space is not a password', () => {
  for (const password of [' ', '   ', '\t']) {
    assert.match(
      parseArgs(['--web', '--host', '0.0.0.0', '--password', password]).error ?? '',
      /needs a value|exposes yoinks/,
      password,
    )
  }
})

test('--max-jobs without the public mode is refused, not silently ignored', () => {
  assert.match(parseArgs(['--web', '--max-jobs', '2']).error ?? '', /--max-jobs only applies/)
  assert.equal(parseArgs(['--web', '--max-jobs', '2', '--password', 'hunter2hunter2']).error, undefined)
})

test('parses the template and a config path', () => {
  assert.equal(parseArgs(['--template', '%(title)s.%(ext)s']).template, '%(title)s.%(ext)s')
  assert.equal(parseArgs(['--template=%(title)s.%(ext)s']).template, '%(title)s.%(ext)s')
  assert.equal(parseArgs(['--config', '/tmp/yoinks.json']).configPath, '/tmp/yoinks.json')
  assert.match(parseArgs(['--template']).error ?? '', /--template needs/)
  assert.match(parseArgs(['--config']).error ?? '', /--config needs/)
})

test('a template without %(ext)s is refused at the flag too', () => {
  // yt-dlp would write files with no extension at all
  assert.match(parseArgs(['--template', '%(title)s']).error ?? '', /%\(ext\)s/)
})
