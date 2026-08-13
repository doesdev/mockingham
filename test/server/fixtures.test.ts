import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'
import { fixtureKey } from '../../src/fixtures/key.ts'
import type { ContentSource } from '../../src/fixtures/source.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, bio: { type: 'string' } },
                  required: ['id', 'bio']
                }
              }
            }
          }
        }
      }
    }
  }
}

function keyFor(id: string): string {
  return fixtureKey({ method: 'get', path: '/users/{id}', params: { id } })
}

test('a whole-body fixture is served in place of generation', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store } })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: '42', bio: 'from the store' })
})

test('a fixture for a different request is not served', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store } })
  const response = await handler.fetch(new Request('https://x/users/43'))
  const body = (await response.json()) as { bio: string }
  assert.notEqual(body.bio, 'from the store')
})

test('changing the seed still reads the same fixture', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), { fixtures: { store }, seed: 'ci-run-7' })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: '42', bio: 'from the store' })
})

test('a user override beats a fixture', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'from the store' } })
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    operations: { 'GET /users/{id}': { 200: { body: { bio: 'from the override' } } } }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  const body = (await response.json()) as { bio: string }
  assert.equal(body.bio, 'from the override')
})

test('no fixture and no llm leaves generation untouched', async () => {
  const handler = createHandler(loadApi(doc), {})
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.equal(response.status, 200)
})

test('lazy mode calls the source once and stores the result', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  const source: ContentSource = {
    generate: async (reqs) => {
      calls += 1
      return reqs.map(() => ({ value: { id: '42', bio: 'lazily fetched' } }))
    }
  }
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  const first = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await first.json(), { id: '42', bio: 'lazily fetched' })
  const second = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await second.json(), { id: '42', bio: 'lazily fetched' })
  assert.equal(calls, 1)
})

test('lazy mode single-flights concurrent identical requests', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  let releaseFirstCall: (() => void) | undefined
  let notifyStarted: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    releaseFirstCall = resolve
  })
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  const source: ContentSource = {
    generate: async (reqs) => {
      calls += 1
      notifyStarted!()
      // Held open until the test explicitly releases it, so the second
      // request is guaranteed to arrive while this call is still pending —
      // not a timer race the second request might simply lose.
      await gate
      return reqs.map(() => ({ value: { id: '42', bio: 'once' } }))
    }
  }
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  const first = handler.fetch(new Request('https://x/users/42'))
  // Wait for the source call itself to have started — synchronously true the
  // instant `generate` begins running, since resolve()'s in-flight map is
  // populated in the same synchronous stretch that invokes `generate` and
  // suspends on its first `await`, before control ever returns to this test.
  // So observing `started` guarantees the in-flight entry already exists.
  await started
  const second = handler.fetch(new Request('https://x/users/42'))
  // Give the second request's own pipeline (auth, validation, idempotency,
  // failure stages — all synchronous logic wrapped in promises, no real I/O
  // or timers by default) a full turn to run to completion up to wherever it
  // can get without the gate opening. A macrotask yield drains the entire
  // microtask queue first, so this deterministically lets the second request
  // reach fixtureResolver.resolve() and either find the existing in-flight
  // promise (correct) or wrongly kick off its own source call (broken) —
  // BEFORE the gate is released and the store gets written. Releasing the
  // gate first would let the second request take an unrelated shortcut (a
  // store hit on the now-persisted fixture) that says nothing about
  // single-flight.
  await new Promise((resolve) => setTimeout(resolve, 0))
  // If single-flight were broken, the second request would have issued its
  // OWN source call by now, while the first is still gated on `gate` — this
  // catches it regardless of timing, not merely because the first finished
  // first.
  assert.equal(calls, 1)
  releaseFirstCall!()
  const [firstResponse, secondResponse] = await Promise.all([first, second])
  assert.deepEqual(await firstResponse.json(), { id: '42', bio: 'once' })
  assert.deepEqual(await secondResponse.json(), { id: '42', bio: 'once' })
  assert.equal(calls, 1)
})

test('a lazy source that throws still serves a generated body', async () => {
  const errors: unknown[] = []
  const handler = createHandler(loadApi(doc), {
    fixtures: { store: createMemoryFixtureStore() },
    llm: {
      mode: 'lazy',
      source: { generate: async () => { throw new Error('down') } },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    },
    onError: (error) => errors.push(error)
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.equal(response.status, 200)
  assert.ok((await response.json()) !== null)
  assert.equal(errors.length, 1)
})

test('off mode never calls the source', async () => {
  let calls = 0
  const store = createMemoryFixtureStore()
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: {
      mode: 'off',
      source: { generate: async (reqs) => { calls += 1; return reqs.map(() => null) } },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  // Not merely "a fixture was served" (there is none to serve, `off` never
  // wrote one) but that the source itself was never invoked, and generation
  // still produced a normal response.
  assert.equal(calls, 0)
  assert.equal(response.status, 200)
  assert.equal(store.records().length, 0)
})

test('live mode calls the source on every request', async () => {
  let calls = 0
  const handler = createHandler(loadApi(doc), {
    fixtures: { store: createMemoryFixtureStore() },
    llm: {
      mode: 'live',
      source: {
        generate: async (reqs) => {
          calls += 1
          return reqs.map(() => ({ value: { id: '42', bio: `call ${calls}` } }))
        }
      },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  await handler.fetch(new Request('https://x/users/42'))
  await handler.fetch(new Request('https://x/users/42'))
  assert.equal(calls, 2)
})

test('live mode does not persist to the store', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: {
      mode: 'live',
      source: {
        generate: async (reqs) => {
          calls += 1
          return reqs.map(() => ({ value: { id: '42', bio: `call ${calls}` } }))
        }
      },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  await handler.fetch(new Request('https://x/users/42'))
  // The direct assertion the mode requires: the store stayed empty, not
  // merely that two responses differed (which a bug that persisted wrongly
  // and then overwrote again could still satisfy).
  assert.equal(store.records().length, 0)
  await handler.fetch(new Request('https://x/users/42'))
  assert.equal(store.records().length, 0)
  assert.equal(calls, 2)
})

test('live mode ignores an existing stored fixture and calls the source anyway', async () => {
  const store = createMemoryFixtureStore()
  // Planted as if a previous lazy or baked run had written it. `live` exists
  // to vary every response regardless of what is already on record, so this
  // must not come back — proving live does not merely fail to WRITE the
  // store (covered elsewhere) but also never READS it.
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'stale from a prior run' } })
  let calls = 0
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: {
      mode: 'live',
      source: {
        generate: async (reqs) => {
          calls += 1
          return reqs.map(() => ({ value: { id: '42', bio: 'freshly live' } }))
        }
      },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  const body = (await response.json()) as { bio: string }
  assert.equal(calls, 1)
  assert.equal(body.bio, 'freshly live')
})

test('a scoped fixture layers beneath the override machinery, a whole fixture replaces generation', async () => {
  const wholeStore = createMemoryFixtureStore()
  wholeStore.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'whole body' } })
  const wholeHandler = createHandler(loadApi(doc), { fixtures: { store: wholeStore } })
  const wholeResponse = await wholeHandler.fetch(new Request('https://x/users/42'))
  const wholeBody = (await wholeResponse.json()) as { id: string; bio: string }
  // A whole-body fixture goes through the generate seam: `id` is exactly
  // what was stored, not blended with anything generated.
  assert.deepEqual(wholeBody, { id: '42', bio: 'whole body' })

  const scopedStore = createMemoryFixtureStore()
  // Scoped: only `bio` is in the fixture, keyed the same as a whole fixture
  // would be — the resolver reads it as `layer`, not `whole`, because the
  // llm scope config says only `bio` is ever in scope.
  scopedStore.set('getUser', 200, keyFor('42'), { value: { bio: 'scoped bio' } })
  const scopedHandler = createHandler(loadApi(doc), {
    fixtures: { store: scopedStore },
    llm: {
      mode: 'off',
      scope: { byName: ['bio'] },
      budget: { maxConcurrency: 4, timeoutMs: 1000 }
    }
  })
  const scopedResponse = await scopedHandler.fetch(new Request('https://x/users/42'))
  const scopedBody = (await scopedResponse.json()) as { id: string; bio: string }
  // A scoped fixture is a LAYER: `bio` comes from the store, `id` still comes
  // from ordinary seeded generation because the fixture never replaced the
  // whole body — proving this went through `renderResponse`'s layer path
  // (`applyOverrides`), not the generate seam's whole-body replacement.
  assert.equal(scopedBody.bio, 'scoped bio')
  assert.equal(typeof scopedBody.id, 'string')
  assert.notEqual(scopedBody, undefined)
})
