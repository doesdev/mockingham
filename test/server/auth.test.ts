import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

// A dedicated document rather than the shared petstore: adding security to that
// fixture would make every existing /pets/7 test start failing on 401.
const doc = {
  openapi: '3.1.0',
  paths: {
    '/guarded': {
      get: {
        operationId: 'guarded',
        security: [{ bearerAuth: ['pets:read'] }],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
              }
            }
          }
        }
      }
    },
    '/open': {
      get: { operationId: 'open', responses: { '200': { description: 'ok' } } }
    }
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }
  }
}

const api = loadApi(doc)
const withToken = { headers: { authorization: 'Bearer abc' } }

test('a protected operation without a credential is 401', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  assert.equal((await handle(new Request('http://mock/guarded'))).status, 401)
})

test('a credential satisfies the presence check', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  const response = await handle(new Request('http://mock/guarded', withToken))
  assert.equal(response.status, 200)
})

test('an unprotected operation is unaffected', async () => {
  const handle = createHandler(api, { seed: 'auth' })
  assert.equal((await handle(new Request('http://mock/open'))).status, 200)
})

test('the principal from verify reaches ctx.auth', async () => {
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'auth',
    auth: { bearerAuth: { verify: () => ({ sub: 'u_9', scopes: ['pets:read'] }) } },
    operations: {
      guarded: {
        respond: (ctx: any) => {
          seen.push(ctx.auth)
          return ctx.respond(200, { ok: true })
        }
      }
    }
  })
  await handle(new Request('http://mock/guarded', withToken))
  assert.deepEqual(seen[0], { sub: 'u_9', scopes: ['pets:read'] })
})

test('unmet scopes are a 403', async () => {
  const handle = createHandler(api, {
    seed: 'auth',
    auth: { bearerAuth: { verify: () => ({ scopes: [] }) } }
  })
  const response = await handle(new Request('http://mock/guarded', withToken))
  assert.equal(response.status, 403)
})
