import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { bake } from '../../src/fixtures/bake.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createHandler } from '../../src/server/handler.ts'

// A source written the way a third-party author would write one: it reads
// FixtureRequest and returns FixtureResult, importing nothing from mockingham
// and nothing from zod. Design section 2.3 — if this stops compiling or stops
// working, the interface has become neutral in name only.
const foreignSource = {
  generate: async (reqs: Array<{ jsonSchema: Record<string, unknown>; status: number }>) =>
    reqs.map((request) => {
      const properties = (request.jsonSchema as { properties?: Record<string, unknown> })
        .properties ?? {}
      const value: Record<string, unknown> = {}
      for (const name of Object.keys(properties).sort()) value[name] = 'x'
      return { value }
    })
}

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/u': {
      get: {
        operationId: 'u',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { bio: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

test('a source can be written against FixtureRequest alone', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    api: loadApi(doc),
    store,
    source: foreignSource as never,
    compiler: createCompiler(),
    now: () => 0
  })
  assert.equal(summary.generated, 1)
  assert.deepEqual(store.records()[0]?.entry.value, { bio: 'x' })
})

// The test above proves bake() will accept and store what the foreign source
// returns. It does not prove the value it stored is genuinely servable —
// bake could in principle accept a shape that resolve.ts then rejects or
// silently ignores at request time. This drives the same foreign fixture
// through a live handler, end to end, so "usable by a third party" means the
// whole pipeline, not just the bake step.
test('a fixture produced by a foreign source is actually served', async () => {
  const store = createMemoryFixtureStore()
  await bake({
    api: loadApi(doc),
    store,
    source: foreignSource as never,
    compiler: createCompiler(),
    now: () => 0
  })
  const handler = createHandler(loadApi(doc), { fixtures: { store } })
  const response = await handler.fetch(new Request('https://x/u'))
  assert.deepEqual(await response.json(), { bio: 'x' })
})
