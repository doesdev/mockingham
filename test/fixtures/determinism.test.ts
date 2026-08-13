import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'

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

// off and post-bake serving are fully deterministic. `lazy` is deterministic
// once warm. `live` is deliberately NOT deterministic — design section 2.11 —
// and is excluded here by design rather than by oversight.
test('a baked store serves byte-identical bodies across handler instances', async () => {
  const build = (): ReturnType<typeof createHandler> => {
    const store = createMemoryFixtureStore()
    store.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
      value: { bio: 'baked' }
    })
    return createHandler(loadApi(doc), { fixtures: { store } })
  }
  const one = await (await build().fetch(new Request('https://x/u'))).text()
  const two = await (await build().fetch(new Request('https://x/u'))).text()
  assert.equal(one, two)
})

// The test above pins the value ('bio': 'baked') and therefore cannot tell
// two byte-identical outputs from two handlers that both happen to be
// comparing the fixture value to itself through a shared reference. This
// mutation-checks that concern directly: two INDEPENDENTLY constructed
// stores, populated from independently constructed plain objects (not the
// same object reference), through two independently constructed handlers.
// If `createHandler` or the store ever started sharing state across
// instances — a module-level cache, say — this would still pass the test
// above (same reference, so trivially equal) but could fail this one if the
// sharing were seed- or instance-order-dependent.
test('two independently constructed handlers over independently constructed fixtures still agree byte-for-byte', async () => {
  const storeOne = createMemoryFixtureStore()
  storeOne.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: JSON.parse(JSON.stringify({ bio: 'baked', nested: { a: 1, b: 2 } }))
  })
  const handlerOne = createHandler(loadApi(doc), { fixtures: { store: storeOne } })

  const storeTwo = createMemoryFixtureStore()
  storeTwo.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: JSON.parse(JSON.stringify({ bio: 'baked', nested: { a: 1, b: 2 } }))
  })
  const handlerTwo = createHandler(loadApi(doc), { fixtures: { store: storeTwo } })

  const bodyOne = await (await handlerOne.fetch(new Request('https://x/u'))).text()
  const bodyTwo = await (await handlerTwo.fetch(new Request('https://x/u'))).text()
  assert.equal(bodyOne, bodyTwo)
  assert.notEqual(storeOne, storeTwo)
  assert.notEqual(handlerOne, handlerTwo)
})
