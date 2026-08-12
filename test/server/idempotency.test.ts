import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
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

  assert.equal((await handle(request())).status, 200)
  assert.equal((await handle(request())).status, 200)
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
  assert.equal((await handle(order('k4'))).status, 503)
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
