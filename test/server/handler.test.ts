import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createHandler } from '../../src/server/handler.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import type { Store } from '../../src/runtime/store.ts'
import { DEFAULT_SEED_TIME, TICKS_PER_ALLOCATION } from '../../src/generate/clock.ts'
import { petstore } from '../fixtures/petstore.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const api = loadApi(petstore)
const handler = createHandler(api, { seed: 'test' }).fetch

test('serves a generated object for a matched route', async () => {
  const res = await handler(new Request('http://x/pets/42'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const body = (await res.json()) as any
  assert.equal(typeof body.id, 'number')
  assert.equal(typeof body.name, 'string')
})

test('serves a generated array', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.ok(Array.isArray(body))
  assert.equal(typeof body[0].name, 'string')
})

test('is deterministic for the same request', async () => {
  const first = await (await handler(new Request('http://x/pets/42'))).json()
  const second = await (await handler(new Request('http://x/pets/42'))).json()
  assert.deepEqual(first, second)
})

test('differs across different path parameters', async () => {
  const a = await (await handler(new Request('http://x/pets/42'))).json()
  const b = await (await handler(new Request('http://x/pets/43'))).json()
  assert.notDeepEqual(a, b)
})
// If this assertion fails it is NOT flaky - generation is deterministic, so
// these two seeds genuinely collided on every field. Change 42/43 to two other
// ids and it will stay passing. Do not weaken the assertion.

test('returns 404 for an unknown path', async () => {
  const res = await handler(new Request('http://x/nope'))
  assert.equal(res.status, 404)
})

test('returns 405 with an Allow header for a known path', async () => {
  const res = await handler(new Request('http://x/pets/42', { method: 'DELETE' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET')
})

test('a 405 carries both the Allow header and an error body', async () => {
  const handle = createHandler(loadApi(petstore), { seed: '405' }).fetch
  const response = await handle(
    new Request('http://mock/pets/7', { method: 'DELETE' })
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
  assert.equal(((await response.json()) as any).error.code, 'MOCK_METHOD_NOT_ALLOWED')
})

test('selects the lowest declared 2xx', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
})

test('honors Prefer: status', async () => {
  const res = await handler(
    new Request('http://x/pets/42', { headers: { prefer: 'status=404' } })
  )
  assert.equal(res.status, 404)
})

test('generates spec-declared response headers', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(typeof res.headers.get('x-next'), 'string')
})

test('emits debug headers when enabled', async () => {
  const debug = createHandler(api, { seed: 'test', debugHeaders: true }).fetch
  const res = await debug(new Request('http://x/pets/42'))
  assert.equal(res.headers.get('x-mock-operation'), 'showPetById')
  assert.ok(res.headers.get('x-mock-seed'))
})

test('a response with no content yields 204-style empty body', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
  assert.equal(await res.text(), '')
})

test('reset clears a caller-supplied store', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { seed: 'reset', store })
  await store.set('left-behind', 1)

  await handler.reset()

  assert.equal(await store.get('left-behind'), undefined)
})

test('reset is awaitable', async () => {
  const handler = createHandler(api, { seed: 'reset' })
  assert.ok(handler.reset() instanceof Promise)
})

test('requestId is deterministic across handlers and distinct across calls', async () => {
  const echo = {
    seed: 'ids',
    operations: {
      // Reading ctx.requestId through a response callback is the only way to
      // observe it; nothing echoes it on a header by default.
      showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) }
    }
  }
  const idFrom = async (handle: (r: Request) => Promise<Response>) =>
    ((await (await handle(new Request('http://x/pets/42'))).json()) as { id: string }).id

  const first = createHandler(api, echo).fetch
  const one = await idFrom(first)
  const two = await idFrom(first)

  // A fresh handler with the same seed replays the same sequence - that is what
  // "stable across processes" means for a correlation id.
  const replay = await idFrom(createHandler(api, echo).fetch)

  assert.notEqual(one, two)
  assert.equal(replay, one)
})

test('an inbound X-Request-Id wins', async () => {
  const handle = createHandler(api, {
    seed: 'ids',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) } }
  }).fetch

  const response = await handle(
    new Request('http://x/pets/42', { headers: { 'x-request-id': 'caller-42' } })
  )

  assert.equal(((await response.json()) as { id: string }).id, 'caller-42')
})

test('the injected clock drives the default store', async () => {
  // Proves `now` actually reaches createMemoryStore rather than only the log
  // record: an outage armed with a TTL must expire when the clock advances.
  // The outage key is `outage|<operationId>` - see outageKey and targetKey in
  // src/runtime/failure.ts. No `failure` policy is needed: checkFailure reads
  // the outage key unconditionally, before it looks at any policy.
  let value = 1_000
  const handler = createHandler(api, { seed: 'clock', now: () => value })
  await handler.store.set('outage|showPetById', { status: 503 }, 5_000)

  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 503)
  value += 6_000
  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 200)
})

test('decisions are populated by the time a response callback runs', async () => {
  const handle = createHandler(api, {
    seed: 'decisions',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, ctx.decisions) } }
  }).fetch

  const body = await (await handle(new Request('http://x/pets/42'))).json()

  // petstore declares no security, so auth is 'anonymous' rather than 'ok' -
  // a real outcome, not a missing one.
  assert.deepEqual(body, { auth: 'anonymous', validation: 'ok', failure: 'ok' })
})

const uuid7Doc = {
  openapi: '3.1.0',
  info: { title: 'ids', version: '1' },
  paths: {
    '/things/{id}': {
      get: {
        operationId: 'getThing',
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
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Two separate operations, so their Store keys differ - a slowdown keyed on
 * one operation cannot be written against a single templated path, because
 * `targetKey` uses the template rather than the resolved params.
 */
const twoOpUuid7Doc = {
  openapi: '3.1.0',
  info: { title: 'ids', version: '1' },
  paths: {
    '/a': {
      get: {
        operationId: 'getA',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    },
    '/b': {
      get: {
        operationId: 'getB',
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** A create operation plus a webhook whose payload also carries a v7. */
const emitUuid7Doc = {
  openapi: '3.1.0',
  info: { title: 'ids', version: '1' },
  webhooks: {
    thingMade: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { id: { type: 'string', format: 'uuid7' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/things': {
      post: {
        operationId: 'makeThing',
        responses: {
          '201': {
            description: 'made',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    },
    '/things/{id}': {
      get: {
        operationId: 'readThing',
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
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

test('ids across successive requests sort by request order', async () => {
  const handle = createHandler(loadApi(uuid7Doc), { seed: 'v7' }).fetch
  const ids: string[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    const body = (await (await handle(new Request(`http://x/things/${id}`))).json()) as any
    ids.push(body.id)
  }
  assert.equal(ids.length, 5)
  assert.deepEqual([...ids].sort(), ids)
})

test('two concurrent requests get ids by issue order, not completion order', async () => {
  // Invariant 2 as amended by the refinements design §4.5. Timestamps used to
  // be drawn from one shared counter AT GENERATION TIME - which is after
  // readOverride, readVariant and the fixture resolver have all awaited - so
  // whichever request finished its lookups first took the earlier timestamp.
  // Blocks are now reserved synchronously on the way in, so issue order wins.
  //
  // The second run makes request `b` slow at the Store, which is enough to
  // flip completion order. If the two runs disagree, the clock is being drawn
  // rather than reserved.
  // TWO DISTINCT OPERATIONS, because `targetKey` uses the operationId (or the
  // route TEMPLATE), so `/things/a` and `/things/b` under one templated path
  // produce byte-identical Store keys and a key-based slowdown never fires.
  //
  // And the comparison slows `a` against slowing `b`, not "slow" against
  // "even". Both requests are issued in one `Promise.all`, so `a` reaches every
  // await first and wins any race by default - slowing only `b` leaves the
  // order unchanged either way and the test cannot fail. Slowing `a` is what
  // lets `b` overtake it, which is exactly what must NOT change the ids.
  //
  // Both of those were wrong in the first draft of this test, and it passed
  // against the mutation it exists to catch until each was fixed.
  const run = async (slow: 'getA' | 'getB'): Promise<string> => {
    const inner = createMemoryStore(() => 0)
    const store: Store = {
      ...inner,
      async get(key: string) {
        if (key.includes(slow)) await new Promise((r) => setTimeout(r, 20))
        return inner.get(key)
      }
    }
    const handle = createHandler(loadApi(twoOpUuid7Doc), { seed: 'v7', store }).fetch
    const [a, b] = await Promise.all([
      handle(new Request('http://x/a')).then((r) => r.json()) as Promise<any>,
      handle(new Request('http://x/b')).then((r) => r.json()) as Promise<any>
    ])
    return `${a.id} ${b.id}`
  }

  const slowA = await run('getA')
  const slowB = await run('getB')
  assert.equal(slowA, slowB)
})

test('a delayed emission does not steal the next request timestamp', async () => {
  // The reproduction that found this: a strictly sequential caller doing POST
  // then GET got a DIFFERENT GET body depending on how long they waited,
  // because the webhook emission generated its payload on a timer somewhere in
  // between and drew from the shared counter. A caller-visible body, not just
  // a webhook payload.
  const run = async (gapMs: number): Promise<string> => {
    const mock = createHandler(loadApi(emitUuid7Doc), {
      seed: 'v7',
      captureOnly: true,
      operations: { makeThing: { emits: [{ webhook: 'thingMade', afterMs: 15 }] } }
    })
    const made = (await (await mock.fetch(
      new Request('http://x/things', { method: 'POST' })
    )).json()) as any
    await new Promise((resolve) => setTimeout(resolve, gapMs))
    const read = (await (await mock.fetch(new Request('http://x/things/a'))).json()) as any
    await mock.settled()
    await mock.close()
    return `${made.id} ${read.id}`
  }

  const fast = await run(0)
  const slow = await run(40)
  assert.equal(slow, fast)
})

test('two emissions of the SAME webhook get separate timestamp blocks', async () => {
  // The tickers were keyed by webhook name, so two entries naming one webhook
  // collapsed to a single block - putting their offsets back on the FIRING
  // path, which is the bug the reservation exists to remove. Two entries for
  // one webhook is the fixture that discriminates; with two DIFFERENT webhooks
  // a name-keyed map behaves correctly and the defect is invisible.
  const mock = createHandler(loadApi(emitUuid7Doc), {
    seed: 'v7',
    captureOnly: true,
    operations: {
      makeThing: {
        emits: [
          { webhook: 'thingMade' },
          { webhook: 'thingMade', afterMs: 10 }
        ]
      }
    }
  })
  await mock.fetch(new Request('http://x/things', { method: 'POST' }))
  await mock.settled()

  // The BLOCK INDEX, not the id and not the raw timestamp. Two emissions
  // sharing one block still produce different ids and different timestamps -
  // offsets 0 and 1 - so asserting either passes against the very defect this
  // test exists to catch. It has to be the block.
  const blocks = mock.deliveries().map((delivery) => {
    const id = (JSON.parse(delivery.body) as { id: string }).id
    const stamp = Number.parseInt(id.slice(0, 13).replace('-', ''), 16)
    return Math.floor((stamp - DEFAULT_SEED_TIME) / TICKS_PER_ALLOCATION)
  })
  await mock.close()

  assert.equal(blocks.length, 2)
  assert.notEqual(blocks[0], blocks[1])
})

test('reset returns the virtual clock to seedTime', async () => {
  const mock = createHandler(loadApi(uuid7Doc), { seed: 'v7' })
  const read = async () =>
    ((await (await mock.fetch(new Request('http://x/things/a'))).json()) as any).id

  const first = await read()
  const second = await read()
  assert.notEqual(first, second, 'the clock must advance between requests')

  await mock.reset()
  assert.equal(await read(), first)
})

test('seedTime places the timestamp where the caller asked', async () => {
  const handle = createHandler(loadApi(uuid7Doc), {
    seed: 'v7',
    seedTime: 1735689600000
  }).fetch
  const body = (await (await handle(new Request('http://x/things/a'))).json()) as any
  const stamp = Number.parseInt(String(body.id).slice(0, 13).replace('-', ''), 16)
  assert.equal(stamp, 1735689600000)
})

test('a seedTime that cannot be a v7 timestamp throws at construction', () => {
  // `seedTime` is public and the realistic bad value is
  // `Date.parse(process.env.SEED_TIME)` on a typo, which is NaN. Left
  // unchecked, NaN reaches the hex encoding and is SERVED - the reviewer saw
  // `00000000-0NaN-7b04-...` come back as an id. 2**48 wraps silently and
  // destroys the sort order that is v7's entire point, and negative and
  // fractional values produce malformed uuids. Every one of them is a caller
  // mistake with no sensible interpretation, so it throws like every other
  // typo in this codebase.
  for (const seedTime of [Number.NaN, -1, 1.5, 2 ** 48, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createHandler(loadApi(uuid7Doc), { seed: 'v7', seedTime }),
      /seedTime/,
      `seedTime ${String(seedTime)} must be rejected`
    )
  }
})

test('an accepted seedTime keeps ids ordered across several requests', async () => {
  // Checks ORDER over several requests, not just the shape of the first id.
  // The previous version did the latter and therefore certified 2**48 - 1 as
  // "accepted" - a value that wraps the 48-bit field on request two and
  // destroys the sort order the validator exists to protect. A boundary test
  // that only looks at the first value cannot see a boundary being crossed.
  for (const seedTime of [0, 2 ** 48 - 2 ** 32]) {
    const handle = createHandler(loadApi(uuid7Doc), { seed: 'v7', seedTime }).fetch
    const ids: string[] = []
    for (const id of ['a', 'b', 'c']) {
      const body = (await (await handle(new Request(`http://x/things/${id}`))).json()) as any
      ids.push(String(body.id))
      assert.match(
        String(body.id),
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        `seedTime ${seedTime} must still produce a well-formed v7`
      )
    }
    assert.deepEqual([...ids].sort(), ids, `seedTime ${seedTime} must keep ids ordered`)
  }
})

test('a seedTime with no room for later blocks is rejected', async () => {
  // 2**48 - 1 fits the field but leaves no headroom: block 1 wraps to near
  // zero and every later id sorts BEFORE the first. Rejected at construction
  // rather than discovered two requests in.
  assert.throws(
    () => createHandler(loadApi(uuid7Doc), { seed: 'v7', seedTime: 2 ** 48 - 1 }),
    /seedTime must be a whole number of milliseconds/
  )
})
