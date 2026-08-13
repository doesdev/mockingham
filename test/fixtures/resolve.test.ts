import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFixtureResolver } from '../../src/fixtures/resolve.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { Compiler } from '../../src/schema/compile.ts'
import type { ContentSource } from '../../src/fixtures/source.ts'

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

const operation = loadApi(doc).operations.find((candidate) => candidate.operationId === 'u')!

// A stand-in Compiler whose `compile()` always throws, standing in for a
// real compilation failure (a `pattern` the runtime regex engine rejects,
// say). This is the only way to exercise the lazy-path buildRequest() call
// throwing, since `createHandler` always wires up a real `createCompiler()`
// internally and has no seam to inject a broken one — this resolver-level
// test is what makes that seam reachable at all.
const throwingCompiler: Compiler = {
  compile: () => {
    throw new Error('compile boom')
  }
}

function sourceReturning(value: unknown): ContentSource {
  return { generate: async (reqs) => reqs.map(() => ({ value })) }
}

test('a throw from buildRequest (e.g. schema compilation) on the lazy path is a miss, not an uncaught rejection', async () => {
  const store = createMemoryFixtureStore()
  const errors: unknown[] = []
  const resolver = createFixtureResolver({
    api: loadApi(doc),
    store,
    compiler: throwingCompiler,
    now: () => 0,
    onError: (error) => errors.push(error),
    llm: {
      mode: 'lazy',
      source: sourceReturning({ bio: 'x' }),
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })

  await assert.doesNotReject(() => resolver.resolve(operation, 200, {}))
  const result = await resolver.resolve(operation, 200, {})
  assert.equal(result, undefined)
  assert.equal(errors.length > 0, true)
})

test('the live path also survives a throw from buildRequest', async () => {
  const store = createMemoryFixtureStore()
  const resolver = createFixtureResolver({
    api: loadApi(doc),
    store,
    compiler: throwingCompiler,
    now: () => 0,
    llm: {
      mode: 'live',
      source: sourceReturning({ bio: 'x' }),
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  const result = await resolver.resolve(operation, 200, {})
  assert.equal(result, undefined)
})

test('a working compiler is unaffected: the lazy path still resolves normally', async () => {
  const store = createMemoryFixtureStore()
  const { createCompiler } = await import('../../src/schema/compile.ts')
  const resolver = createFixtureResolver({
    api: loadApi(doc),
    store,
    compiler: createCompiler(),
    now: () => 0,
    llm: {
      mode: 'lazy',
      source: sourceReturning({ bio: 'fetched' }),
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  const result = await resolver.resolve(operation, 200, {})
  assert.deepEqual(result, { whole: { bio: 'fetched' } })
})

// --- FIX 7: shape() reads scoped-ness from the entry, not ambient config ---

test('an entry marked scoped in meta is applied as a layer even with no ambient scope config', async () => {
  const store = createMemoryFixtureStore()
  store.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: { bio: 'scoped bio' },
    meta: { scoped: true }
  })
  const resolver = createFixtureResolver({ api: loadApi(doc), store, compiler: throwingCompiler, now: () => 0 })
  const result = await resolver.resolve(operation, 200, {})
  assert.deepEqual(result, { layer: { bio: 'scoped bio' } })
})

test('an entry with no meta at all stays whole-body by default', async () => {
  const store = createMemoryFixtureStore()
  store.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: { bio: 'hand-written' }
  })
  const resolver = createFixtureResolver({ api: loadApi(doc), store, compiler: throwingCompiler, now: () => 0 })
  const result = await resolver.resolve(operation, 200, {})
  assert.deepEqual(result, { whole: { bio: 'hand-written' } })
})
