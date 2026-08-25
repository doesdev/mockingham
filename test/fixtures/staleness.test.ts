import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { loadFixtures, warnOnStaleFixtures } from '../../src/fixtures/persist.ts'
import { bake } from '../../src/fixtures/bake.ts'
import { schemaHash } from '../../src/fixtures/source.ts'
import { operationSlug } from '../../src/fixtures/key.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import type { Compiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { Api } from '../../src/spec/types.ts'

test('a schemaHash mismatch warns once and the fixture is still served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mockingham-stale-'))
  await writeFile(
    join(dir, 'getUser.json'),
    JSON.stringify({ '200': { k: { value: { id: 1 }, meta: { schemaHash: 'old' } } } })
  )
  const store = createMemoryFixtureStore()
  await loadFixtures(dir, store)
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'new', (m) => warnings.push(m))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] as string, /getUser/)
  // Still there. Design section 2.13: warn, never reject.
  assert.deepEqual(store.get('getUser', 200, 'k')?.value, { id: 1 })
})

test('a hand-written fixture with no meta is never reported stale', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k', { value: { id: 1 } })
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'new', (m) => warnings.push(m))
  assert.equal(warnings.length, 0)
})

test('a matching schemaHash does not warn', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k', { value: { id: 1 }, meta: { schemaHash: 'same' } })
  const warnings: string[] = []
  warnOnStaleFixtures(store, () => 'same', (m) => warnings.push(m))
  assert.equal(warnings.length, 0)
})

// The three tests above never put more than one stale record in a store, so
// none of them can distinguish "warns once per stale fixture" from "warns
// once per store" or "warns once per operation" - a mutant that returns
// after the first warning, or that dedupes by operationId, would pass all
// three. This exercises two stale fixtures at once: two different statuses
// under the SAME operation, plus one fresh and one hand-written record mixed
// in, and asserts the warning count and identity precisely.
test('warnOnStaleFixtures warns once per stale fixture, not once per store or once per operation', () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, 'k1', { value: { id: 1 }, meta: { schemaHash: 'old' } }) // stale
  store.set('getUser', 404, 'k2', { value: { message: 'gone' }, meta: { schemaHash: 'old' } }) // stale, same operation
  store.set('listItems', 200, 'k3', { value: { id: 2 }, meta: { schemaHash: 'match' } }) // fresh
  store.set('listItems', 500, 'k4', { value: { id: 3 } }) // hand-written, no meta

  const hashFor = (operationId: string, status: number): string | undefined => {
    if (operationId === 'listItems' && status === 200) return 'match'
    return 'new'
  }
  const warnings: string[] = []
  warnOnStaleFixtures(store, hashFor, (m) => warnings.push(m))

  assert.equal(warnings.length, 2)
  assert.ok(warnings.some((w) => /getUser/.test(w) && /\b200\b/.test(w)))
  assert.ok(warnings.some((w) => /getUser/.test(w) && /\b404\b/.test(w)))
})

// Everything above hand-builds `meta`, which is exactly the pattern the task
// brief warns produces tests that cannot fail: `bake` currently writes no
// `schemaHash` at all unless this file's `bake.ts` change actually wires it
// up. This test bakes a REAL fixture through `bake()`, then re-derives the
// current hash the same way production wiring (`src/index.ts`) does - via
// `schemaHash` and the document's own operations - and checks the two paths
// agree on the unchanged document and disagree once the schema changes.
const baseDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/u': {
      get: {
        operationId: 'getUser',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'integer' } } }
              }
            }
          }
        }
      }
    }
  }
}

// Same operation, but the 200 schema has grown a property - a document that
// moved under the fixture.
const changedDoc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/u': {
      get: {
        operationId: 'getUser',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'integer' }, name: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

function hashForDocument(api: Api, compiler: Compiler) {
  return (operationId: string, status: number): string | undefined => {
    const operation = api.operations.find((candidate) => operationSlug(candidate) === operationId)
    const response = operation?.responses.find((entry) => entry.status === status)
    const media = response?.content['application/json']
    return media ? schemaHash(media.schema, compiler) : undefined
  }
}

test('bake writes a schemaHash that the startup check reads back unchanged, and detects a real schema change', async () => {
  const compiler = createCompiler()
  const store = createMemoryFixtureStore()

  await bake({
    api: loadApi(baseDoc),
    store,
    source: { generate: async (reqs) => reqs.map(() => ({ value: { id: 1 } })) },
    compiler,
    now: () => 0
  })

  // bake must have actually written a schemaHash - if it did not, the rest
  // of this test would pass vacuously (no stored hash means
  // warnOnStaleFixtures always skips it, "no warning" either way).
  const baked = store.get('getUser', 200, store.records()[0]?.key ?? '')
  assert.ok(baked?.meta?.schemaHash, 'bake must write meta.schemaHash')

  // Re-load the SAME document (a fresh Api instance, as a real process
  // restart would produce) and check: no warning.
  const unchangedWarnings: string[] = []
  warnOnStaleFixtures(
    store,
    hashForDocument(loadApi(baseDoc), compiler),
    (m) => unchangedWarnings.push(m)
  )
  assert.equal(unchangedWarnings.length, 0)

  // Now check against the CHANGED document: a warning appears, naming the
  // operation.
  const changedWarnings: string[] = []
  warnOnStaleFixtures(
    store,
    hashForDocument(loadApi(changedDoc), compiler),
    (m) => changedWarnings.push(m)
  )
  assert.equal(changedWarnings.length, 1)
  assert.match(changedWarnings[0] as string, /getUser/)

  // The fixture is still there after the warning - same guarantee as the
  // single-fixture test above, re-proven on the real bake path.
  assert.deepEqual(store.get('getUser', 200, store.records()[0]?.key ?? '')?.value, { id: 1 })
})
