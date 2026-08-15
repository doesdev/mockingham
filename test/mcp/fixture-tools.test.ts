import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock, createMemoryFixtureStore } from '../../src/index.ts'
import { contextForMock, toolNamed } from './helpers.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import type { ContentSource, FixtureResult } from '../../src/fixtures/source.ts'
import type { FixtureStore } from '../../src/fixtures/store.ts'

const jsonBody = (properties: Record<string, unknown>) => ({
  description: 'a response',
  content: { 'application/json': { schema: { type: 'object', properties } } }
})

function docWith(bioType = 'string') {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/users': {
        get: {
          operationId: 'listUsers',
          responses: {
            '200': jsonBody({ bio: { type: bioType } }),
            '404': jsonBody({ message: { type: 'string' } })
          }
        }
      },
      '/orders': {
        get: {
          operationId: 'listOrders',
          responses: { '200': jsonBody({ total: { type: 'number' } }) }
        }
      }
    }
  }
}

/**
 * A source whose value can change between runs. Regeneration replacing a
 * stored entry is only observable when the second run returns something
 * different — with a constant value the assertion passes against a
 * regeneration that never wrote anything.
 */
function mutableSource(): { state: { value: unknown }; source: ContentSource } {
  const state: { value: unknown } = { value: { round: 'first' } }
  return {
    state,
    source: { generate: async (reqs) => reqs.map(() => ({ value: state.value }) as FixtureResult) }
  }
}

function mockWith(
  source: ContentSource,
  options: { doc?: Record<string, unknown>; store?: FixtureStore; now?: number } = {}
) {
  return createMock(options.doc ?? docWith(), {
    seed: 'fixtures',
    now: () => options.now ?? 1_000,
    fixtures: { store: options.store ?? createMemoryFixtureStore() },
    llm: { mode: 'bake', source } as never
  })
}

test('regenerate_fixture re-runs the source for one operation and status', async () => {
  const { state, source } = mutableSource()
  const mock = mockWith(source)
  await mock.bake()

  state.value = { round: 'second' }
  const summary = (await toolNamed('regenerate_fixture', { write: true }).handler(
    contextForMock(mock), { operationId: 'listUsers', status: 200 }
  )) as { generated: number }

  assert.equal(summary.generated, 1)

  const records = mock.fixtures()
  const regenerated = records.find(
    (record) => record.operationId === 'listUsers' && record.status === 200
  )
  const untouched = records.find((record) => record.operationId === 'listOrders')
  assert.deepEqual(regenerated?.entry.value, { round: 'second' })
  assert.deepEqual(untouched?.entry.value, { round: 'first' })
})

test('regenerate_fixture reports the summary rather than a bare ok', async () => {
  // An agent handed {ok: true} for a run that skipped everything has been
  // misinformed, so generated/skipped/failed must reach the caller.
  const { source } = mutableSource()
  const mock = mockWith(source)

  const summary = (await toolNamed('regenerate_fixture', { write: true }).handler(
    contextForMock(mock), { operationId: 'listUsers' }
  )) as Record<string, unknown>

  assert.deepEqual(Object.keys(summary).sort(), ['failed', 'generated', 'skipped'])
  assert.equal(summary.generated, 2, 'both declared JSON statuses')
})

test('regenerate_fixture selects by method and path too', async () => {
  const { state, source } = mutableSource()
  const mock = mockWith(source)
  await mock.bake()

  state.value = { round: 'second' }
  await toolNamed('regenerate_fixture', { write: true }).handler(
    contextForMock(mock), { method: 'get', path: '/orders' }
  )

  const records = mock.fixtures()
  assert.deepEqual(
    records.find((record) => record.operationId === 'listOrders')?.entry.value,
    { round: 'second' }
  )
  assert.deepEqual(
    records.find((record) => record.operationId === 'listUsers')?.entry.value,
    { round: 'first' }
  )
})

test('regenerate_fixture without an llm source refuses with an actionable message', async () => {
  const mock = createMock(docWith(), { seed: 'no-llm' })
  await assert.rejects(
    async () =>
      toolNamed('regenerate_fixture', { write: true }).handler(
        contextForMock(mock), { operationId: 'listUsers' }
      ),
    /llm source/
  )
})

test('regenerate_fixture reports an unknown operation as an error', async () => {
  const { source } = mutableSource()
  const mock = mockWith(source)
  await assert.rejects(
    async () =>
      toolNamed('regenerate_fixture', { write: true }).handler(
        contextForMock(mock), { operationId: 'nope' }
      ),
    /nope/
  )
})

test('regenerate_fixture is gated, list_fixtures is not', () => {
  const open = mcpTools({ write: true }).map((tool) => tool.name)
  const closed = mcpTools().map((tool) => tool.name)

  assert.ok(!closed.includes('regenerate_fixture'), 'write tool must be gated')
  assert.ok(open.includes('regenerate_fixture'))
  // A read tool. If it needs the gate it is in the wrong registry.
  assert.ok(closed.includes('list_fixtures'))
})

test('list_fixtures reports what is stored, without values by default', async () => {
  const { source } = mutableSource()
  const mock = mockWith(source)
  await mock.bake()

  const listed = (await toolNamed('list_fixtures').handler(
    contextForMock(mock), {}
  )) as Array<Record<string, unknown>>

  assert.equal(listed.length, 3)
  assert.deepEqual(
    listed.map((entry) => `${entry.operationId}|${entry.status}`).sort(),
    ['listOrders|200', 'listUsers|200', 'listUsers|404']
  )
  assert.ok(
    listed.every((entry) => !Object.hasOwn(entry, 'value')),
    'values are opt-in — a whole document of them is a lot to hand an agent'
  )
  assert.equal(listed[0]?.generatedAt, new Date(1_000).toISOString())
})

test('list_fixtures narrows to one operation and status', async () => {
  const { source } = mutableSource()
  const mock = mockWith(source)
  await mock.bake()

  const listed = (await toolNamed('list_fixtures').handler(
    contextForMock(mock), { operationId: 'listUsers', status: 404 }
  )) as Array<Record<string, unknown>>

  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.status, 404)
})

test('includeValues returns the stored value', async () => {
  const { source } = mutableSource()
  const mock = mockWith(source)
  await mock.bake()

  const listed = (await toolNamed('list_fixtures').handler(
    contextForMock(mock), { operationId: 'listOrders', includeValues: true }
  )) as Array<Record<string, unknown>>

  assert.deepEqual(listed[0]?.value, { round: 'first' })
})

test('stale is false against the document a fixture was baked from, true after it moves', async () => {
  // Both halves in one test on purpose: `stale: true` alone passes against a
  // hardcoded true, and `stale: false` alone against a hardcoded false.
  const store = createMemoryFixtureStore()
  const { source } = mutableSource()
  const baked = mockWith(source, { store })
  await baked.bake()

  const fresh = (await toolNamed('list_fixtures').handler(
    contextForMock(baked), { operationId: 'listUsers', status: 200 }
  )) as Array<Record<string, unknown>>
  assert.equal(fresh[0]?.stale, false, 'just baked against this very document')

  // The same store, read against a document whose schema has moved.
  const moved = mockWith(source, { store, doc: docWith('number') })
  const listed = (await toolNamed('list_fixtures').handler(
    contextForMock(moved), { operationId: 'listUsers', status: 200 }
  )) as Array<Record<string, unknown>>
  assert.equal(listed[0]?.stale, true, 'bio changed from string to number')
})

test('regenerating a stale fixture clears its staleness', async () => {
  const store = createMemoryFixtureStore()
  const { source } = mutableSource()
  const baked = mockWith(source, { store })
  await baked.bake()

  const moved = mockWith(source, { store, doc: docWith('number') })
  await toolNamed('regenerate_fixture', { write: true }).handler(
    contextForMock(moved), { operationId: 'listUsers', status: 200 }
  )

  const listed = (await toolNamed('list_fixtures').handler(
    contextForMock(moved), { operationId: 'listUsers', status: 200 }
  )) as Array<Record<string, unknown>>
  assert.equal(listed[0]?.stale, false, 'regeneration is the remedy for staleness')
})
