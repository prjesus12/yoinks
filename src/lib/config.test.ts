import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {loadConfig, resolveOptions} from './config.js'

/** A config file is a convenience, but a wrong one must say so — a typo that
 *  silently does nothing is the classic way config files waste an afternoon. */

async function withConfig(contents: string | undefined): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-config-'))
  const file = path.join(dir, 'config.json')
  if (contents !== undefined) await fs.writeFile(file, contents)
  return file
}

test('no config file is not an error', async () => {
  const file = await withConfig(undefined)
  assert.deepEqual(await loadConfig(file), {})
})

test('a valid config file is read', async () => {
  const file = await withConfig(
    JSON.stringify({outDir: '~/Music', template: '%(title)s.%(ext)s', theme: 'dark', preset: 'mp3'}),
  )
  assert.deepEqual(await loadConfig(file), {
    outDir: '~/Music',
    template: '%(title)s.%(ext)s',
    theme: 'dark',
    preset: 'mp3',
  })
})

test('broken json names the file instead of silently defaulting', async () => {
  const file = await withConfig('{ not json')
  await assert.rejects(loadConfig(file), (error: Error) => {
    assert.match(error.message, /config\.json/)
    return true
  })
})

test('an unknown key is refused, with the valid ones listed', async () => {
  const file = await withConfig(JSON.stringify({templat: 'typo.%(ext)s'}))
  await assert.rejects(loadConfig(file), (error: Error) => {
    assert.match(error.message, /templat/, 'it should name the key that is wrong')
    assert.match(error.message, /template/, 'and say what the valid keys are')
    return true
  })
})

test('a template without %(ext)s is refused', async () => {
  // yt-dlp would write files with no extension at all
  const file = await withConfig(JSON.stringify({template: '%(title)s'}))
  await assert.rejects(loadConfig(file), /%\(ext\)s/)
})

test('a bad theme or preset is refused', async () => {
  await assert.rejects(loadConfig(await withConfig(JSON.stringify({theme: 'sepia'}))), /theme/)
  await assert.rejects(loadConfig(await withConfig(JSON.stringify({preset: 'flac'}))), /preset/)
})

test('flags win over the config file, and the config file over the defaults', () => {
  const config = {outDir: '~/Music', template: 'config.%(ext)s', theme: 'light' as const, preset: 'm4a' as const}

  const fromFlags = resolveOptions(
    {outDir: '~/Videos', template: 'flag.%(ext)s', themeMode: 'dark', preset: 'mp3'},
    config,
  )
  assert.deepEqual(fromFlags, {
    outDir: '~/Videos',
    template: 'flag.%(ext)s',
    themeMode: 'dark',
    preset: 'mp3',
  })

  const fromConfig = resolveOptions({}, config)
  assert.deepEqual(fromConfig, {
    outDir: '~/Music',
    template: 'config.%(ext)s',
    themeMode: 'light',
    preset: 'm4a',
  })

  const fromNothing = resolveOptions({}, {})
  assert.deepEqual(fromNothing, {outDir: undefined, template: undefined, themeMode: 'auto', preset: undefined})
})

test('a config path the user named must exist', async () => {
  const file = await withConfig(undefined)
  // absent and not asked for: fine
  assert.deepEqual(await loadConfig(file), {})
  // absent and explicitly requested: say so instead of running with defaults
  await assert.rejects(loadConfig(file, {mustExist: true}), /does not exist/)
})
