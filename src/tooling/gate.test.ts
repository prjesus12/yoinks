import assert from 'node:assert/strict'
import {readFileSync, readdirSync, statSync} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

/**
 * Guards for the gates themselves. A linter that is silently suppressed, or a
 * test script whose glob never reaches a file, both look green — these tests
 * are what makes "green" mean something.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE_DIRS = ['src', 'web/src']
/** This file quotes the pattern it looks for, so it cannot police itself. */
const SELF = 'src/tooling/gate.test.ts'
const DISABLE = 'eslint-disable'

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(root, dir))) {
    const relative = `${dir}/${entry}`
    if (statSync(path.join(root, relative)).isDirectory()) sourceFiles(relative, found)
    else if (/\.tsx?$/.test(entry)) found.push(relative)
  }
  return found
}

const scanned = () => SOURCE_DIRS.flatMap(dir => sourceFiles(dir)).filter(file => file !== SELF)

/**
 * oxlint applies `// <disable>-next-line <rule>` to everything below it in the
 * same block, so one sitting above a closing `}, [deps])` line silences
 * unrelated rules for the whole component. Keep them on the line they guard.
 */
test('a disable comment never sits above a closing line', () => {
  const offenders: string[] = []
  for (const file of scanned()) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (!line.includes(`${DISABLE}-next-line`)) return
      const next = lines.slice(index + 1).find(candidate => candidate.trim()) ?? ''
      if (/^[}\])]/.test(next.trim())) offenders.push(`${file}:${index + 1}`)
    })
  }
  assert.deepEqual(offenders, [], `move these to \`// ${DISABLE}-line <rule> -- reason\` on the guarded line`)
})

test('every disable comment names its rule', () => {
  const offenders: string[] = []
  for (const file of scanned()) {
    readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const match = new RegExp(`${DISABLE}(?:-next-line|-line)?(\\s+\\S+)?`).exec(line)
        if (match && !match[1]) offenders.push(`${file}:${index + 1}`)
      })
  }
  assert.deepEqual(offenders, [], 'a bare disable turns off everything on that line')
})

/** `tsx --test src/**\/*.test.ts` expands one directory deep in sh — no globstar. */
test('every test file is reached by the test script glob', () => {
  const unreachable = sourceFiles('src').filter(file => /^src\/[^/]+\.test\.ts$/.test(file))
  assert.deepEqual(unreachable, [], 'the script glob only reaches src/<dir>/*.test.ts — nest it or widen the glob')
})
