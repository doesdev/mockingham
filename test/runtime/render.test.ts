import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderResponse } from '../../src/runtime/render.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Ctx } from '../../src/runtime/types.ts'
import type { ResponseSpec } from '../../src/spec/types.ts'

const ctx = {} as Ctx

function spec(status: number): ResponseSpec {
  return {
    status,
    headers: {},
    content: {
      'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } }
    }
  }
}

function render(overrides: Partial<Parameters<typeof renderResponse>[0]> = {}) {
  return renderResponse({
    ctx,
    chosen: spec(200),
    bodyOverrides: [],
    headerOverrides: {},
    resolvers: compileResolvers(),
    rngFor: (label) => createRng(`r|${label}`),
    generateOptions: {},
    generate: () => ({ a: 'generated' }),
    example: () => undefined,
    ...overrides
  })
}

test('serializes the generated body as JSON', async () => {
  const response = await render()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.deepEqual(await response.json(), { a: 'generated' })
})

test('applies body overrides in order', async () => {
  const response = await render({
    bodyOverrides: [{ a: 'first', b: 'first' }, { a: 'second' }]
  })
  assert.deepEqual(await response.json(), { a: 'second', b: 'first' })
})

test('a named example beats generation', async () => {
  const response = await render({
    exampleName: 'empty',
    example: (_status, name) => (name === 'empty' ? { a: 'from-example' } : undefined)
  })
  assert.deepEqual(await response.json(), { a: 'from-example' })
})

test('an absent body yields a bodiless response with no content type', async () => {
  const response = await render({
    chosen: { status: 204, headers: {}, content: {} },
    generate: () => undefined
  })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('content-type'), null)
})

test('content-type is applied last and cannot be overridden', async () => {
  const response = await render({ headerOverrides: { 'content-type': 'text/plain' } })
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('debug headers are added when requested', async () => {
  const response = await render({
    debug: { seed: '123', source: 'prefer', operationId: 'showPet' }
  })
  assert.equal(response.headers.get('x-mock-seed'), '123')
  assert.equal(response.headers.get('x-mock-status-source'), 'prefer')
  assert.equal(response.headers.get('x-mock-operation'), 'showPet')
})

test('debug headers are absent by default', async () => {
  const response = await render()
  assert.equal(response.headers.get('x-mock-seed'), null)
})

test('a promise left in the generated tree is settled', async () => {
  const response = await render({ generate: () => ({ a: Promise.resolve('settled') }) })
  assert.deepEqual(await response.json(), { a: 'settled' })
})

test('a scoped fixture layer overlays the generated body', async () => {
  const response = await render({
    generate: () => ({ id: 1, bio: 'generated' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the fixture' })
})

test('a user override beats the fixture layer', async () => {
  const response = await render({
    generate: () => ({ id: 1, bio: 'generated' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: [{ bio: 'from the override' }]
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the override' })
})

test('the fixture layer beats a spec example', async () => {
  const response = await render({
    exampleName: 'sample',
    example: () => ({ id: 1, bio: 'from the example' }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'from the fixture' })
})

test('no fixture layer leaves rendering unchanged', async () => {
  const response = await render({
    generate: () => ({ id: 1, bio: 'generated' }),
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { id: 1, bio: 'generated' })
})

test('swapping the layer order would let the fixture beat the override', async () => {
  // Pins the ORDER, not just the outcome: a fixture-only test cannot catch a
  // swap of [fixtureLayer, ...bodyOverrides] to [...bodyOverrides, fixtureLayer].
  // Two overrides target the same key so only the winning layer's value survives.
  const response = await render({
    generate: () => ({ id: 1, bio: 'generated', tag: 'generated' }),
    fixtureLayer: { bio: 'from the fixture', tag: 'from the fixture' },
    bodyOverrides: [{ tag: 'from the override' }]
  })
  const result = await response.json() as { bio: string; tag: string }
  assert.equal(result.bio, 'from the fixture')
  assert.equal(result.tag, 'from the override')
})

test('a fixture layer with no user overrides still settles a promise', async () => {
  const response = await render({
    generate: () => ({ a: Promise.resolve('settled') }),
    fixtureLayer: { bio: 'from the fixture' },
    bodyOverrides: []
  })
  assert.deepEqual(await response.json(), { a: 'settled', bio: 'from the fixture' })
})
