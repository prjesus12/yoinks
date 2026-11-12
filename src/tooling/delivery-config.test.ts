import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

/**
 * The test script and the CI matrix have to agree. `--test-force-exit` is what
 * keeps a failing shutdown test from hanging the job until the runner gives up,
 * and it only exists from node 22 — a row below that turns every run red.
 */
const MIN_NODE = 22
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

test('the test script asks for --test-force-exit', () => {
  const scripts = (JSON.parse(read('package.json')) as {scripts: Record<string, string>}).scripts
  assert.match(scripts.test!, /--test-force-exit/, 'the shutdown tests hang without it')
})

test('every CI node row can run the flags the test script needs', () => {
  const matrix = /^\s*node:\s*\[([^\]]*)\]/m.exec(read('.github/workflows/ci.yml'))
  assert.ok(matrix, 'ci.yml no longer declares a node matrix')
  const versions = matrix[1]!.split(',').map(value => Number(value.trim()))
  assert.notDeepEqual(versions, [], 'an empty matrix tests nothing')
  assert.deepEqual(
    versions.filter(version => !Number.isFinite(version) || version < MIN_NODE),
    [],
    `every ci.yml node row must be >= ${MIN_NODE} to run --test-force-exit`,
  )
})

test('the declared engine floor matches what the runtime dependencies need', () => {
  const pkg = JSON.parse(read('package.json')) as {engines: {node: string}}
  const floor = Number(/\d+/.exec(pkg.engines.node)?.[0])
  assert.equal(Number.isFinite(floor), true, pkg.engines.node)
  assert.equal(floor! >= MIN_NODE, true, `engines says ${pkg.engines.node}, but ink 7 needs ${MIN_NODE}`)
})
