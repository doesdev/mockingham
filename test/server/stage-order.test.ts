import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

const guarded = loadApi({
  openapi: '3.1.0',
  paths: {
    '/secret/{id}': {
      get: {
        operationId: 'secret',
        security: [{ b: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
        ],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } }
})

test('auth answers before validation', async () => {
  // Both are wrong: no credential AND a non-integer id. Auth is stage 3 and
  // validation stage 4, so the caller must learn about auth and nothing else.
  const handle = createHandler(guarded, { seed: 'order' }).fetch
  const response = await handle(new Request('http://mock/secret/abc'))
  assert.equal(response.status, 401)
})

test('validation answers once authenticated', async () => {
  const handle = createHandler(guarded, { seed: 'order' }).fetch
  const response = await handle(
    new Request('http://mock/secret/abc', { headers: { authorization: 'Bearer x' } })
  )
  assert.equal(response.status, 400)
})

test('an unauthenticated request never reaches a response callback', async () => {
  let reached = false
  const handle = createHandler(guarded, {
    seed: 'order',
    operations: {
      secret: {
        respond: (ctx) => {
          reached = true
          return ctx.respond(200, {})
        }
      }
    }
  }).fetch
  const response = await handle(new Request('http://mock/secret/1'))
  assert.equal(response.status, 401)
  assert.equal(reached, false)
})

const orderable = loadApi({
  openapi: '3.1.0',
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { qty: { type: 'integer' } },
                required: ['qty']
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    }
  }
})

const orderWith = (key: string, body: string) =>
  new Request('http://mock/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body
  })

test('idempotency answers after validation: a malformed request never claims its key', async () => {
  // handler.ts pushes the idempotency stage after validation specifically so
  // "a malformed request must never claim a key it cannot honor" - if that
  // ordering regressed, the invalid request below would claim the key before
  // validation ever ran, and its 400 (not excluded by stage 11's "never store
  // a 5xx" rule) would be stored under it. A same-keyed, corrected retry would
  // then find that record and see its own body fingerprint disagree with the
  // stored one - 409 MOCK_IDEMPOTENCY_MISMATCH - rather than actually
  // executing. Mutation-verified: swapping the two `stages.push` calls in
  // handler.ts turns this test's 201 into a 409.
  const handle = createHandler(orderable, { seed: 'order' }).fetch

  const invalid = await handle(orderWith('stage-order-1', '{}'))
  assert.equal(invalid.status, 400)

  const retry = await handle(orderWith('stage-order-1', '{"qty":1}'))
  assert.equal(retry.status, 201)
  assert.equal(retry.headers.get('idempotent-replay'), null)
})
