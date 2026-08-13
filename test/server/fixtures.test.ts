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

// What `bake()` writes: an empty-params key, since bake runs offline with no
// concrete request in hand. `resolve.ts` reads this back as "applies to any
// request for this operation and status."
function wildcardKey(): string {
  return fixtureKey({ method: 'get', path: '/users/{id}', params: {} })
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

// A lazy source whose calls are counted rather than merely asserted-against
// inline: `resolve()` wraps the source call in a try/catch (invariant 4 — a
// throwing source must never propagate), so throwing from inside `generate`
// would be silently swallowed and never surface as a loud test failure; it
// would just fall through to seeded generation, same as any other miss. A
// counter checked by the caller afterward is what actually lets the test
// observe an unwanted call.
//
// Its presence matters because `resolve()` is the only place that decides
// whether to call the source at all — `renderResponse`'s `fixture` hook
// falls back to a synchronous `peek()` whenever `resolve()` found nothing, so
// a body-only assertion could pass even with `resolve()`'s own wildcard
// fallback broken, entirely on the strength of `peek()`'s. `calls` stays 0
// only if `resolve()` itself found the wildcard fixture and never reached
// the "call the source" branch.
function countingSource(): { source: ContentSource; calls: () => number } {
  let calls = 0
  return {
    source: {
      generate: async (reqs) => {
        calls += 1
        return reqs.map(() => ({ value: { id: 'from-source', bio: 'should not have been called' } }))
      }
    },
    calls: () => calls
  }
}

test('a baked fixture, stored under the empty-params key, is served for a parameterized request', async () => {
  const store = createMemoryFixtureStore()
  // What bake() actually writes: no concrete id, because it ran offline.
  store.set('getUser', 200, wildcardKey(), { value: { id: 'any', bio: 'baked for any id' } })
  const { source, calls } = countingSource()
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: 'any', bio: 'baked for any id' })
  assert.equal(calls(), 0)
})

test('the same baked fixture is served for a different id', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, wildcardKey(), { value: { id: 'any', bio: 'baked for any id' } })
  const { source, calls } = countingSource()
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  // Proves the wildcard genuinely applies to any request, not that it
  // coincidentally matched the one id exercised above.
  const response = await handler.fetch(new Request('https://x/users/999'))
  assert.deepEqual(await response.json(), { id: 'any', bio: 'baked for any id' })
  assert.equal(calls(), 0)
})

test('an exact-key fixture beats a wildcard fixture for the same request', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, wildcardKey(), { value: { id: 'any', bio: 'baked for any id' } })
  store.set('getUser', 200, keyFor('42'), { value: { id: '42', bio: 'specific to 42' } })
  const { source, calls } = countingSource()
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })

  const exactResponse = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await exactResponse.json(), { id: '42', bio: 'specific to 42' })

  // A different id has no exact entry, so it still falls back to the
  // wildcard — precedence, not exclusivity.
  const wildcardResponse = await handler.fetch(new Request('https://x/users/7'))
  assert.deepEqual(await wildcardResponse.json(), { id: 'any', bio: 'baked for any id' })
  assert.equal(calls(), 0)
})

test('a full response callback sees the wildcard fixture too', async () => {
  const store = createMemoryFixtureStore()
  store.set('getUser', 200, wildcardKey(), { value: { id: 'any', bio: 'baked for any id' } })
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    // The `peek()` path: a response callback runs before status selection
    // and calls ctx.generate() directly, which must agree with the ordinary
    // pipeline about whether a baked fixture exists for this request.
    operations: {
      'GET /users/{id}': { respond: (ctx: any) => ctx.respond(200, ctx.generate(200)) }
    }
  })
  const response = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await response.json(), { id: 'any', bio: 'baked for any id' })
})

test('lazy mode still writes under the exact key, so a different id is not served the cached value', async () => {
  const store = createMemoryFixtureStore()
  let calls = 0
  const source: ContentSource = {
    generate: async (reqs) => {
      calls += 1
      return reqs.map((req) => ({ value: { id: req.params.id, bio: `fetched for ${req.params.id}` } }))
    }
  }
  const handler = createHandler(loadApi(doc), {
    fixtures: { store },
    llm: { mode: 'lazy', source, budget: { maxConcurrency: 4, timeoutMs: 1000 } }
  })
  const first = await handler.fetch(new Request('https://x/users/42'))
  assert.deepEqual(await first.json(), { id: '42', bio: 'fetched for 42' })

  // No wildcard entry was ever written (lazy never writes one), and no exact
  // entry exists for 43 — the wildcard fallback must not let 42's cached
  // value leak into this request.
  const second = await handler.fetch(new Request('https://x/users/43'))
  assert.deepEqual(await second.json(), { id: '43', bio: 'fetched for 43' })
  assert.equal(calls, 2)
})
