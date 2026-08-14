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

test('every reader-facing markdown file is covered by the harness', async () => {
  const entries = await readdir(join(REPO, 'docs'))
  const guides = entries.filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)
  const covered = new Set<string>(DOCUMENTS)
  const uncovered = guides.filter((path) => !covered.has(path))
  assert.deepEqual(
    uncovered,
    [],
    `these documents have no subtest: ${uncovered.join(', ')}`
  )
})

for (const document of DOCUMENTS) {
  test(`${document} runs and prints what it claims`, async () => {
    await assertDocument(join(REPO, document))
  })
}
