import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertDocument } from './harness.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** Every document the harness runs. Adding a guide means adding it here. */
const DOCUMENTS = [
  'README.md',
  'docs/fixtures.md',
  'docs/webhooks.md',
  'docs/logging-datadog.md',
  'docs/mcp.md'
] as const

/**
 * Reader-facing markdown that is deliberately not executed, each with a reason.
 * An exemption is a decision someone makes by name - the point of the sweep is
 * that nothing becomes uncovered by accident.
 */
const EXEMPT = new Map<string, string>([
  ['CLAUDE.md', 'operating manual for agents working ON this repo, not for its readers'],
  ['docs/superpowers', 'design specs, plans, and the deferred-items ledger - internal process records'],
  ['test/docs/fixtures', 'deliberately broken documents that exist to prove the harness rejects them']
])

/** Every markdown file in the repo, ignoring build and dependency output. */
async function walkMarkdown(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(REPO, dir), { withFileTypes: true })
  const found: string[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
      found.push(...(await walkMarkdown(join(dir, entry.name), relative)))
      continue
    }
    if (entry.name.endsWith('.md')) found.push(relative)
  }
  return found
}

test('every reader-facing markdown file is covered by the harness', async () => {
  // Walks the whole repo recursively, not `docs/` one level deep with
  // README.md hardcoded into the run list and never verified to exist.
  // A guide in a subdirectory, or a new top-level CONTRIBUTING.md, used to be
  // silently uncovered. Deferred item 40.
  const all = await walkMarkdown('.')
  const covered = new Set<string>(DOCUMENTS)

  const uncovered = all.filter((path) => {
    if (covered.has(path)) return false
    for (const exempt of EXEMPT.keys()) {
      if (path === exempt || path.startsWith(`${exempt}/`)) return false
    }
    return true
  })

  assert.deepEqual(
    uncovered,
    [],
    `these documents have no subtest and no exemption: ${uncovered.join(', ')}`
  )

  // The run list must not name a file that no longer exists, which the old
  // sweep could not catch for README.md - it was a literal entry, exercised
  // only because its own subtest happened to run.
  for (const document of DOCUMENTS) {
    assert.ok(all.includes(document), `${document} is in the run list but not on disk`)
  }
})

for (const document of DOCUMENTS) {
  test(`${document} runs and prints what it claims`, async () => {
    await assertDocument(join(REPO, document))
  })
}
