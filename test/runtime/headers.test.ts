import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeaders } from '../../src/runtime/headers.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { ResponseSpec } from '../../src/spec/types.ts'

const spec: ResponseSpec = {
  status: 200,
  headers: { 'x-next': { type: 'string' }, 'x-count': { type: 'integer' } },
  content: {}
}

function build(overrides: Record<string, unknown> = {}, extra = {}) {
  return buildHeaders({
    spec,
    ctx: {} as never,
    rngFor: (name) => createRng(`h|${name}`),
    generateOptions: {},
    overrides,
    ...extra
  })
}

test('generates declared response headers from their schemas', async () => {
  const headers = await build()
  assert.equal(typeof headers.get('x-next'), 'string')
  assert.match(headers.get('x-count') ?? '', /^\d+$/)
})

test('global defaults overwrite generated headers', async () => {
  const headers = await build({}, { globals: { 'x-next': 'from-global' } })
  assert.equal(headers.get('x-next'), 'from-global')
})

test('byName resolvers overwrite global defaults', async () => {
  const headers = await build({}, {
    globals: { 'x-next': 'from-global' },
    resolvers: compileResolvers({ byName: [['x-next', () => 'from-resolver']] })
  })
  assert.equal(headers.get('x-next'), 'from-resolver')
})

test('a byName resolver pattern matches the header name case-insensitively', async () => {
  const headers = await build({}, {
    resolvers: compileResolvers({ byName: [['X-Next', () => 'from-resolver']] })
  })
  assert.equal(headers.get('x-next'), 'from-resolver')
})

test('per-operation overrides beat everything below them', async () => {
  const headers = await build({ 'x-next': 'from-operation' }, {
    globals: { 'x-next': 'from-global' },
    resolvers: compileResolvers({ byName: [['x-next', () => 'from-resolver']] })
  })
  assert.equal(headers.get('x-next'), 'from-operation')
})

test('a function header override is called with ctx', async () => {
  const headers = await build({ 'x-rate-limit-remaining': () => 99 })
  assert.equal(headers.get('x-rate-limit-remaining'), '99')
})

test('an async header override is awaited', async () => {
  const headers = await build({ 'x-slow': async () => 'done' })
  assert.equal(headers.get('x-slow'), 'done')
})

test('a null or undefined value omits the header entirely', async () => {
  const headers = await build({ 'x-next': null, 'x-count': undefined })
  assert.equal(headers.get('x-next'), null)
  // undefined means "no override", so the generated value survives
  assert.match(headers.get('x-count') ?? '', /^\d+$/)
})

test('header names are matched case-insensitively', async () => {
  const headers = await build({ 'X-NEXT': 'upper' })
  assert.equal(headers.get('x-next'), 'upper')
})

test('an override may add a header the response does not declare', async () => {
  const headers = await build({ 'x-extra': 'added' })
  assert.equal(headers.get('x-extra'), 'added')
})

test('resolvers do not invent headers that no layer set', async () => {
  const headers = await build({}, {
    resolvers: compileResolvers({ byName: [['x-absent', () => 'nope']] })
  })
  assert.equal(headers.get('x-absent'), null)
})
