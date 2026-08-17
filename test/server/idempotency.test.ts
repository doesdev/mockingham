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
  // `/plain` declares a bodyless 200, so a spurious replay is ALSO a 200 -
  // asserting only the status cannot tell "idempotency correctly stayed out
  // of the way" from "idempotency engaged and replayed". The replay header is
  // the one signal that distinguishes them.
  assert.equal(second.headers.get('idempotent-replay'), null)
})

/**
 * A counter in the response is what makes the replay test able to fail.
 * Generation is deterministic, so two real executions already return identical
 * bytes - a replay test that only compares bodies passes with idempotency
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
  // from a stored 503" - a stored/replayed 503 is exactly what the 5xx
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
  // (`circuit: { after: 3, openFor: 10_000, then: 429 }`) - reachable through
  // `decide()` too, as here. Mirrors the '5xx is not stored' test above.
  // The injection is gated on its OWN counter, not on `attempts`. Gating it on
  // `attempts` - as this test did until the ledger caught it (item 19) - meant
  // `respond` never ran, so `attempts` never left 0, so `decide` fired every
  // time and the retry never re-ran. The name promised re-execution that no
  // assertion checked.
  let decideCalls = 0
  let attempts = 0
  const handle = createHandler(api, {
    seed: 'idem',
    decide: () => (decideCalls++ === 0 ? { status: 429 } : undefined),
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
  // The retry genuinely re-runs, which is what the name claims.
  assert.equal(second.status, 201)
  assert.equal(attempts, 1, 'the operation executed on the retry, and only then')
  // A stored 429 would replay with this header set; its absence is what
  // distinguishes "the mock injected 429 again" from "a stored 429 replayed"
  // - exactly the outcome §2.6 exists to prevent.
  assert.equal(second.headers.get('idempotent-replay'), null)
})

test('two concurrent identical requests execute the operation once', async () => {
  // Item 15's own probe: plan 5 measured `runs: 2`, both 201, because the
  // claim was a `get` followed by a `set` with an await between them.
  //
  // The observation is a COUNTER, not a body comparison. Generation is seeded,
  // so two real executions return byte-identical responses - comparing them
  // proves nothing about whether one or both ran.
  let runs = 0
  const handle = createHandler(api, {
    seed: 'idem',
    operations: {
      createOrder: {
        respond: async (ctx) => {
          runs += 1
          // Holds the first request open across a macrotask so the second
          // genuinely arrives while the first is still in flight. Without
          // this the two never overlap and the test proves nothing.
          await new Promise((resolve) => setTimeout(resolve, 10))
          return ctx.respond(201, { ok: true })
        }
      }
    }
  }).fetch

  const [first, second] = await Promise.all([
    handle(order('race')),
    handle(order('race'))
  ])

  assert.equal(runs, 1, 'the operation must execute exactly once')
  // One wins the claim and answers; the other is told it is in flight.
  assert.deepEqual([first.status, second.status].sort(), [201, 409])
})

test('a failed body capture stores nothing, so a retry can execute', async () => {
  // Previously stored `{ body: null }`, pinning a bodiless replay for the full
  // TTL - a transient capture failure became a persistently wrong response.
  let runs = 0
  const failing = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('body stream failed'))
        }
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    )

  const handle = createHandler(api, {
    seed: 'idem',
    onError: () => {},
    operations: {
      createOrder: {
        respond: () => {
          runs += 1
          return failing()
        }
      }
    }
  }).fetch

  await handle(order('capture-fail'))
  await handle(order('capture-fail'))

  // Both executed: nothing was stored, so the second was not a replay and was
  // not refused as in-flight either.
  assert.equal(runs, 2)
})

test('a store whose set() rejects still returns the real response, not a rejection', async () => {
  // C1: stage 11's store write used to run bare, outside any catch. A Store
  // is caller-supplied code (invariant 4), and before this fix a failure here
  // rejected fetch() entirely, destroying an already-correct 201.
  const base = createMemoryStore()
  let calls = 0
  const store: Store = {
    ...base,
    async set(_key, _value, _ttlMs) {
      // Stage 5's in-flight claim goes through `setIfAbsent` now (item 15), so
      // the ONLY `set` a claimed request makes is stage 11's final write - the
      // one under test. This used to let the first call through and throw on
      // the second, which after the claim moved would never have thrown at all.
      calls += 1
      throw new Error('store set boom')
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
  assert.equal(calls, 1, 'exactly one set: stage 11, the claim uses setIfAbsent')
  assert.equal((errors[0] as Error).message, 'store set boom')
})

test('a respond callback returning an already-read Response still returns it', async () => {
  // The same C1 root cause, reached a different way: a proxy-through callback
  // naturally returns a Response it already consumed, which makes
  // `response.clone()` throw inside body capture. That only happens when
  // `onLog` is set or a key was claimed - this exercises both at once.
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
