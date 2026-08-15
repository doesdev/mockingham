import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bake } from '../../src/fixtures/bake.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { ContentSource, FixtureResult } from '../../src/fixtures/source.ts'

const jsonBody = (properties: Record<string, unknown>) => ({
  description: 'a response',
  content: { 'application/json': { schema: { type: 'object', properties } } }
})

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: {
          '200': jsonBody({ bio: { type: 'string' } }),
          '404': jsonBody({ message: { type: 'string' } })
        }
      }
    },
    '/orders': {
      get: {
        operationId: 'listOrders',
        responses: { '200': jsonBody({ total: { type: 'number' } }) }
      }
    },
    '/text': {
      get: {
        operationId: 'textOnly',
        responses: {
          '200': {
            description: 'plain text, nothing to bake',
            content: { 'text/plain': { schema: { type: 'string' } } }
          }
        }
      }
    }
  }
}

function sourceReturning(value: unknown): ContentSource {
  return { generate: async (reqs) => reqs.map(() => ({ value }) as FixtureResult) }
}

function baseOptions(store = createMemoryFixtureStore()) {
  return {
    api: loadApi(doc),
    store,
    source: sourceReturning({ any: 'value' }),
    compiler: createCompiler(),
    now: () => 0
  }
}

test('a filter bakes one operation and leaves the rest alone', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    ...baseOptions(store),
    only: { operationId: 'listUsers' }
  })

  // Both halves matter. The count alone passes against a filter that bakes
  // the wrong single operation.
  assert.equal(summary.generated, 2, 'both declared JSON statuses')
  assert.deepEqual(
    [...new Set(store.records().map((record) => record.operationId))],
    ['listUsers']
  )
})

test('a filter narrows to one status', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    ...baseOptions(store),
    only: { operationId: 'listUsers', status: 404 }
  })

  assert.equal(summary.generated, 1)
  assert.deepEqual(store.records().map((record) => record.status), [404])
})

test('method and path select the same operation as operationId', async () => {
  const byId = createMemoryFixtureStore()
  const byRoute = createMemoryFixtureStore()

  await bake({ ...baseOptions(byId), only: { operationId: 'listUsers' } })
  await bake({ ...baseOptions(byRoute), only: { method: 'get', path: '/users' } })

  // The same stored keys, not merely the same count: two different operations
  // would both store two records.
  assert.deepEqual(
    byRoute.records().map((record) => `${record.operationId}|${record.status}`),
    byId.records().map((record) => `${record.operationId}|${record.status}`)
  )
  assert.equal(byId.records().length, 2)
})

test('a mismatched operationId and method/path pair throws', async () => {
  // Deliberately NOT repeating findOperation's residual (deferred item 29a),
  // which ignores method/path whenever operationId is supplied.
  await assert.rejects(
    () =>
      bake({
        ...baseOptions(),
        only: { operationId: 'listUsers', method: 'get', path: '/orders' }
      }),
    /listUsers/
  )
})

test('an unknown operation throws rather than reporting a successful no-op', async () => {
  await assert.rejects(
    () => bake({ ...baseOptions(), only: { operationId: 'nope' } }),
    /nope/
  )
})

test('a status the operation does not declare throws', async () => {
  await assert.rejects(
    () => bake({ ...baseOptions(), only: { operationId: 'listUsers', status: 418 } }),
    /418/
  )
})

test('a matched operation with nothing bakeable is skipped, not an error', async () => {
  // The design's distinction: "you named something that does not exist" throws,
  // "what you named cannot be baked" is reported in the summary.
  const store = createMemoryFixtureStore()
  const summary = await bake({
    ...baseOptions(store),
    only: { operationId: 'textOnly' }
  })

  assert.equal(summary.generated, 0)
  assert.equal(summary.skipped, 1)
  assert.deepEqual(store.records(), [])
})

test('regenerating replaces the stored entry rather than appending', async () => {
  // The source returns a DIFFERENT value the second time on purpose. With an
  // identical value this passes with the second write removed entirely —
  // determinism makes replace-versus-noop invisible otherwise.
  const store = createMemoryFixtureStore()
  await bake({ ...baseOptions(store), source: sourceReturning({ round: 'first' }) })

  const before = store.records().length
  await bake({
    ...baseOptions(store),
    source: sourceReturning({ round: 'second' }),
    only: { operationId: 'listUsers', status: 200 }
  })

  const records = store.records()
  assert.equal(records.length, before, 'replaced, not appended')
  const regenerated = records.find(
    (record) => record.operationId === 'listUsers' && record.status === 200
  )
  assert.deepEqual(regenerated?.entry.value, { round: 'second' })
  // Everything else keeps the value it was baked with.
  const untouched = records.find((record) => record.operationId === 'listOrders')
  assert.deepEqual(untouched?.entry.value, { round: 'first' })
})

test('regenerating refreshes generatedAt', async () => {
  const store = createMemoryFixtureStore()
  await bake({ ...baseOptions(store), now: () => 1_000 })
  await bake({
    ...baseOptions(store),
    now: () => 9_000,
    only: { operationId: 'listUsers', status: 200 }
  })

  const records = store.records()
  const regenerated = records.find(
    (record) => record.operationId === 'listUsers' && record.status === 200
  )
  const untouched = records.find((record) => record.operationId === 'listOrders')
  assert.equal(regenerated?.entry.meta?.generatedAt, new Date(9_000).toISOString())
  assert.equal(untouched?.entry.meta?.generatedAt, new Date(1_000).toISOString())
})

test('a filter still respects maxCalls, reporting the remainder as skipped', async () => {
  const store = createMemoryFixtureStore()
  const summary = await bake({
    ...baseOptions(store),
    only: { operationId: 'listUsers' },
    budget: { maxCalls: 1 }
  })

  assert.equal(summary.generated, 1)
  assert.equal(summary.skipped, 1, 'the second planned status is over budget')
})

test('no filter still bakes the whole document', async () => {
  // The filter is optional and must not change the default walk.
  const store = createMemoryFixtureStore()
  const summary = await bake(baseOptions(store))
  assert.equal(summary.generated, 3, 'two for listUsers, one for listOrders')
  assert.equal(summary.skipped, 1, 'textOnly has no JSON body')
})
