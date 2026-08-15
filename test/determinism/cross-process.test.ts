import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Invariant 2's cross-process half. `scripts/determinism.ts` has existed since
 * plan 1 to be run twice and diffed by hand, and nothing ever ran it — the
 * stronger claim the README makes by name, and the one the phase-12 docs
 * harness rests on ("a doc can promise exact bytes"), was asserted nowhere.
 *
 * A test, not a script: this must spawn REAL processes. Two `createMock` calls
 * inside one process share module state, a warm rng, and the same heap, so
 * they prove nothing about a second `node` invocation.
 */

const root = fileURLToPath(new URL('../..', import.meta.url))

function runOnce(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['scripts/determinism.ts'], {
    cwd: root,
    encoding: 'utf8'
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('two separate processes produce byte-identical output', () => {
  const first = runOnce()
  const second = runOnce()

  // The guards come BEFORE the comparison and are the point of them: two
  // crashed processes both print nothing and compare equal, so a broken
  // script would report determinism it never demonstrated. This is the exact
  // shape the previous determinism proof had — it compared two responses to
  // each other, which a fixed seed already guarantees, and passed with the
  // whole subsystem removed.
  assert.equal(first.status, 0, `first run failed: ${first.stderr}`)
  assert.equal(second.status, 0, `second run failed: ${second.stderr}`)
  assert.ok(first.stdout.length > 0, 'the script printed nothing')
  assert.equal(
    first.stdout.trim().split('\n').length,
    3,
    'expected one line per probed path'
  )
  // Each line must carry a generated body, not just a status: a script that
  // printed three bare statuses would satisfy the count and still compare
  // equal with generation entirely broken.
  for (const line of first.stdout.trim().split('\n')) {
    assert.match(line, /\{|\[/, `no body in: ${line}`)
  }

  assert.equal(first.stdout, second.stdout)
})
