import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {prettyPath} from './views.js'

// the API sends paths already shortened, so the browser never has to guess
test('prettyPath shortens paths under the real home and nothing else', () => {
  const home = os.homedir()
  assert.equal(prettyPath(path.join(home, 'Downloads')), '~/Downloads')
  assert.equal(prettyPath(home), '~')
  assert.equal(prettyPath('/Volumes/Media'), '/Volumes/Media')
  // a sibling whose name extends the home directory is not inside it
  assert.equal(prettyPath(`${home}elsewhere/Movies`), `${home}elsewhere/Movies`)
})
