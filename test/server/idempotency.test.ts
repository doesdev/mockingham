import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import type { Store } from '../../src/runtime/store.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    },
    '/plain': {
      post: {
        operationId: 'plain',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
})

export const order = (key: string, body = '{"item":"a"}') =>
  new Request('http://mock/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body
  })

test('the same key with a different body conflicts', async () => {
  // Default scope. This is the case §11 describes and §2.7 makes reachable.
  const handle = createHandler(api, { seed: 'idem' }).fetch

  await handle(order('k2', '{"item":"a"}'))
  const response = await handle(order('k2', '{"item":"b"}'))

  assert.equal(response.status, 409)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'MOCK_IDEMPOTENCY_MISMATCH')
})

test('an operation with no key parameter is untouched', async () => {
  const handle = createHandler(api, { seed: 'idem' }).fetch
  const request = () =>
    new Request('http://mock/plain', { method: 'POST', headers: { 'idempotency-key': 'k' } })

  const first = await handle(request())
  const second = await handle(request())

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  // `/plain` declares a bodyless 200, so a spurious replay is ALSO a 200 —
  // asserting only the status cannot tell "idempotency correctly stayed out
  // of the way" from "idempotency engaged and replayed". The replay header is
  // the one signal that distinguishes them.
  assert.equal(second.headers.get('idempotent-replay'), null)
})

/**
 * A counter in the response is what makes the replay test able to fail.
 * Generation is deterministic, so two real executions already return identical
 * bytes — a replay test that only compares bodies passes with idempotency
 * removed entirely. Counting executions is the mechanism under test.
 */
function counting() {
  let runs = 0
  return {
    runs: () => runs,
    operations: {
      createOrder: {
        respond: (ctx: Ctx) => {
          runs += 1
          return ctx.respond(201, { run: runs })
        }
      }
    }
  }
}

test('a replay returns the first response byte-for-byte and does not re-execute', async () => {
  const spy = counting()
  const handle = createHandler(api, { seed: 'idem', operations: spy.operations }).fetch

  const first = await handle(order('k1'))
  const firstBody = await first.text()
  const second = await handle(order('k1'))
  const secondBody = await second.text()

  assert.equal(secondBody, firstBody)
  assert.equal(secondBody, '{"run":1}')
  assert.equal(spy.runs(), 1)
  assert.equal(first.headers.get('idempotent-replay'), null)
  assert.equal(second.headers.get('idempotent-replay'), 'true')
})

test('config.methods enables an operation the document did not mark', async () => {
  const handle = createHandler(api, {
    seed: 'idem',
    idempotency: { methods: ['POST'] }
  }).fetch
  const request = () =>
    new Request('http://mock/plain', { method: 'POST', headers: { 'idempotency-key': 'k9' } })

  await handle(request())
  assert.equal((await handle(request())).headers.get('idempotent-replay'), 'true')
})

test('a claimed key is released when the request throws', async () => {
  // The wedge case: without this, every retry sees a marker that never resolves.
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    operations: {
      createOrder: {
        respond: (ctx) => {
          attempts += 1
          if (attempts === 1) throw new Error('boom')
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  assert.equal((await handle(order('k3'))).status, 500)
  const retry = await handle(order('k3'))

  assert.equal(retry.status, 201)
  assert.equal(attempts, 2)
})

test('a 5xx is not stored, so a retry re-runs', async () => {
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    decide: () => (attempts === 0 ? { status: 503 } : undefined),
    operations: {
      createOrder: {
        respond: (ctx) => {
          attempts += 1
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  assert.equal((await handle(order('k4'))).status, 503)
  const second = await handle(order('k4'))
  assert.equal(second.status, 503)
  // A stored 5xx would replay with this header set; asserting it stays absent
  // is what distinguishes "re-run, coincidentally also 503" from "replayed
  // from a stored 503" — a stored/replayed 503 is exactly what the 5xx
  // exclusion exists to prevent.
  assert.equal(second.headers.get('idempotent-replay'), null)
})

test('a 4xx IS stored and replays', async () => {
  // A client error is a real answer to the key. Only 5xx is excluded, because a
  // 5xx is precisely what the caller retries the key to survive.
  const handle = createHandler(api, {
    seed: 'idem',
    operations: { createOrder: { respond: (ctx) => ctx.respond(422, { bad: true }) } }
  }).fetch

  assert.equal((await handle(order('k5'))).status, 422)
  const replay = await handle(order('k5'))

  assert.equal(replay.status, 422)
  assert.equal(replay.headers.get('idempotent-replay'), 'true')
})

test('a stored record expires', async () => {
  let value = 0
  let runs = 0
  const handle = createHandler(api, {
    seed: 'idem',
    now: () => value,
    idempotency: { ttlMs: 1_000 },
    operations: {
      createOrder: {
        respond: (ctx) => {
          runs += 1
          return ctx.respond(201, { run: runs })
        }
      }
    }
  }).fetch

  await handle(order('k6'))
  value += 2_000
  await handle(order('k6'))

  assert.equal(runs, 2)
})

test('an injected 429 is not stored, so a retry re-runs', async () => {
  // I2: §2.6 exists to stop a chaos-injected failure from pinning a key for
  // the TTL. The original condition only excluded `status >= 500`, but the
  // master spec's own canonical circuit example injects 429
  // (`circuit: { after: 3, openFor: 10_000, then: 429 }`) — reachable through
  // `decide()` too, as here. Mirrors the '5xx is not stored' test above.
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    decide: () => (attempts === 0 ? { status: 429 } : undefined),
    operations: {
      createOrder: {
        respond: (ctx) => {
          attempts += 1
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  assert.equal((await handle(order('k7'))).status, 429)
  const second = await handle(order('k7'))
  assert.equal(second.status, 429)
  // A stored 429 would replay with this header set; its absence is what
  // distinguishes "the mock injected 429 again" from "a stored 429 replayed"
  // — exactly the outcome §2.6 exists to prevent.
  assert.equal(second.headers.get('idempotent-replay'), null)
})

test('a store whose set() rejects still returns the real response, not a rejection', async () => {
  // C1: stage 11's store write used to run bare, outside any catch. A Store
  // is caller-supplied code (invariant 4), and before this fix a failure here
  // rejected fetch() entirely, destroying an already-correct 201.
  const base = createMemoryStore()
  let calls = 0
  const store: Store = {
    ...base,
    async set(key, value, ttlMs) {
      calls += 1
      // The first set() is stage 5's in-flight claim — it must succeed so the
      // key is genuinely claimed. The second is stage 11's final write, the
      // one under test.
      if (calls > 1) throw new Error('store set boom')
      return base.set(key, value, ttlMs)
    }
  }
  const errors: unknown[] = []
  const handle = createHandler(api, {
    seed: 'idem',
    store,
    onError: (error) => errors.push(error)
  }).fetch

  const response = await handle(order('k8'))

  assert.equal(response.status, 201)
  assert.equal(calls, 2)
  assert.equal((errors[0] as Error).message, 'store set boom')
})

test('a respond callback returning an already-read Response still returns it', async () => {
  // The same C1 root cause, reached a different way: a proxy-through callback
  // naturally returns a Response it already consumed, which makes
  // `response.clone()` throw inside body capture. That only happens when
  // `onLog` is set or a key was claimed — this exercises both at once.
  const errors: unknown[] = []
  const handle = createHandler(api, {
    seed: 'idem',
    onLog: () => {},
    onError: (error) => errors.push(error),
    operations: {
      createOrder: {
        respond: async (ctx) => {
          const response = await ctx.respond(201, { ok: true })
          await response.text()
          return response
        }
      }
    }
  }).fetch

  const response = await handle(order('k9'))

  assert.equal(response.status, 201)
  assert.ok(errors.length > 0)
})

/**
 * Body-pointer keys (delta design §6). A separate document, because the point
 * is an operation that declares NO Idempotency-Key header parameter and whose
 * method config names nothing — the configured pointer is the only route to
 * idempotency. It also declares no `security`, so auth (stage 3) cannot
 * short-circuit before the idempotency stage (stage 5) is reached.
 */
const eventsApi = loadApi({
  openapi: '3.1.0',
  paths: {
    '/events': {
      post: {
        operationId: 'deliverEvent',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    }
  }
})

/**
 * A counter, for the same reason as `counting()` above: seeded generation makes
 * two real executions byte-identical, so comparing bodies alone would pass with
 * idempotency removed entirely. Counting executions is the mechanism under test.
 */
function eventHandler(body: unknown) {
  const state = { runs: 0 }
  const handle = createHandler(eventsApi, {
    seed: 'idem',
    idempotency: { operations: { deliverEvent: { key: '{$request.body#/meta/requestId}' } } },
    operations: {
      deliverEvent: {
        respond: (ctx: Ctx) => {
          state.runs += 1
          return ctx.respond(200, { ok: true })
        }
      }
    }
  }).fetch
  const send = () =>
    handle(
      new Request('http://mock/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
  return { state, send }
}

test('a body pointer that resolves to nothing leaves the request non-idempotent', async () => {
  const { state, send } = eventHandler({ meta: {} })

  const first = await send()
  const second = await send()

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  // The specific outcome, not merely "no error": the request really executed
  // twice, and nothing was replayed.
  assert.equal(state.runs, 2)
  assert.equal(second.headers.get('idempotent-replay'), null)
})

test('the same body pointer value replays', async () => {
  const { state, send } = eventHandler({ meta: { requestId: 'r-1' } })

  await send()
  const second = await send()

  assert.equal(state.runs, 1)
  assert.equal(second.headers.get('idempotent-replay'), 'true')
})

test('a different body under the same body-pointer key conflicts', async () => {
  // The interaction §6.4 records: the pointer key lives INSIDE the body it is
  // fingerprinted against, so the same requestId with any other field differing
  // is MOCK_IDEMPOTENCY_MISMATCH under the default scope.
  const handle = createHandler(eventsApi, {
    seed: 'idem',
    idempotency: { operations: { deliverEvent: { key: '{$request.body#/meta/requestId}' } } }
  }).fetch
  const send = (item: string) =>
    handle(
      new Request('http://mock/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { requestId: 'r-2' }, item })
      })
    )

  await send('a')
  const response = await send('b')

  assert.equal(response.status, 409)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'MOCK_IDEMPOTENCY_MISMATCH')
})

test('a bare operation key expression keys on the body, not on its own text', async () => {
  // Un-normalized, `$request.body#/meta/requestId` matches no token, so
  // `resolveExpression` hands back the literal expression text as the key.
  // Every request in the document then collapses onto that one key and the
  // second one conflicts with a request it shares nothing with.
  const handle = createHandler(eventsApi, {
    seed: 'idem',
    idempotency: { operations: { deliverEvent: { key: '$request.body#/meta/requestId' } } }
  }).fetch
  const send = (requestId: string) =>
    handle(
      new Request('http://mock/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { requestId } })
      })
    )

  const first = await send('r-bare-1')
  const second = await send('r-bare-2')

  assert.equal(first.status, 200)
  // Two distinct request ids are two distinct keys: the second is a first
  // request of its own, neither a conflict nor a replay.
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('idempotent-replay'), null)
})

test('a bare operation key keys on the VALUE, so distinct ids do not collide', async () => {
  // The previous version of this test sent one requestId twice and asserted a
  // replay — which passes whether or not the expression is normalized, because
  // an un-normalized key collapses every request onto the literal expression
  // text and the second request replays for the wrong reason. Two DIFFERENT
  // ids are what discriminate: under the bug they share a key and, with the
  // default bodyHash scope, the second is a 409 mismatch rather than a fresh
  // success.
  const handle = createHandler(eventsApi, {
    seed: 'idem',
    idempotency: { operations: { deliverEvent: { key: '$request.body#/meta/requestId' } } }
  }).fetch
  const send = (requestId: string) =>
    handle(
      new Request('http://mock/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { requestId } })
      })
    )

  const first = await send('r-bare-3')
  assert.equal(first.headers.get('idempotent-replay'), null)

  const other = await send('r-bare-4')
  assert.notEqual(other.status, 409, 'a different id must not conflict with the first')
  assert.equal(other.headers.get('idempotent-replay'), null)

  const repeat = await send('r-bare-3')
  assert.equal(repeat.headers.get('idempotent-replay'), 'true')
})
