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

test('a second request against an unresolved key is in flight', async () => {
  // Stage 11 does not store anything yet, so the first request's claim is still
  // outstanding when the second arrives. This is the honest end state of the
  // read half on its own — Task 7 turns this pair into a replay.
  const handle = createHandler(api, { seed: 'idem' }).fetch

  await handle(order('k1'))
  const second = await handle(order('k1'))

  assert.equal(second.status, 409)
  assert.equal(
    ((await second.json()) as { error: { code: string } }).error.code,
    'MOCK_IDEMPOTENCY_IN_FLIGHT'
  )
})
