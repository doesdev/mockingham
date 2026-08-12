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
  const handle = createHandler(guarded, { seed: 'order' })
  const response = await handle(new Request('http://mock/secret/abc'))
  assert.equal(response.status, 401)
})

test('validation answers once authenticated', async () => {
  const handle = createHandler(guarded, { seed: 'order' })
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
  })
  const response = await handle(new Request('http://mock/secret/1'))
  assert.equal(response.status, 401)
  assert.equal(reached, false)
})
