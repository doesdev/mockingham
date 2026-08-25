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
// once warm. `live` is deliberately NOT deterministic - design section 2.11 -
// and is excluded here by design rather than by oversight.
//
// This is the file the design designates as the determinism proof for the
// whole fixture subsystem, so the assertion that matters is that the SERVED
// BODY IS THE STORED FIXTURE VALUE - not merely that two responses agree
// with each other. Two responses agreeing is guaranteed by the pre-existing
// seeded generator for a fixed seed with no fixture involved at all, so a
// same-as-itself comparison proves nothing about fixture resolution
// specifically; a body that failed to resolve the fixture at all and instead
// generated a value would still pass a same-as-itself check every time.
test('a baked store serves the stored fixture value, byte-identically, across handler instances', async () => {
  const fixtureValue = { bio: 'baked' }
  const build = (): ReturnType<typeof createHandler> => {
    const store = createMemoryFixtureStore()
    store.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
      value: fixtureValue
    })
    return createHandler(loadApi(doc), { fixtures: { store } })
  }
  const one = await (await build().fetch(new Request('https://x/u'))).text()
  const two = await (await build().fetch(new Request('https://x/u'))).text()
  assert.equal(one, two)
  assert.deepEqual(JSON.parse(one), fixtureValue)
})

// The test above pins the value ('bio': 'baked') through a SHARED plain
// object literal, so it cannot tell "the fixture was actually resolved" from
// "two handlers happened to compare the same reference to itself". This
// drives the same claim through two INDEPENDENTLY constructed stores,
// populated from independently constructed plain objects (not the same
// object reference, and via a JSON round trip so no reference survives at
// all), through two independently constructed handlers - and checks each
// served body against the fixture value directly, not merely against each
// other.
test('two independently constructed handlers over independently constructed fixtures each serve the stored fixture value', async () => {
  const fixtureValue = { bio: 'baked', nested: { a: 1, b: 2 } }

  const storeOne = createMemoryFixtureStore()
  storeOne.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: JSON.parse(JSON.stringify(fixtureValue))
  })
  const handlerOne = createHandler(loadApi(doc), { fixtures: { store: storeOne } })

  const storeTwo = createMemoryFixtureStore()
  storeTwo.set('u', 200, fixtureKey({ method: 'get', path: '/u', params: {} }), {
    value: JSON.parse(JSON.stringify(fixtureValue))
  })
  const handlerTwo = createHandler(loadApi(doc), { fixtures: { store: storeTwo } })

  const bodyOne = await (await handlerOne.fetch(new Request('https://x/u'))).text()
  const bodyTwo = await (await handlerTwo.fetch(new Request('https://x/u'))).text()
  assert.equal(bodyOne, bodyTwo)
  // `doc`'s schema only declares a `bio` property - `nested` has no schema
  // to have been generated from. A body that matches this exactly can only
  // have come from the stored fixture, whole, not from seeded generation.
  assert.deepEqual(JSON.parse(bodyOne), fixtureValue)
  assert.deepEqual(JSON.parse(bodyTwo), fixtureValue)
})
