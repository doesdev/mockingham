import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'

// Exercised through the 415 that body parsing already emits on its own: the
// operation declares application/json, so posting XML is a genuine
// content-negotiation failure rather than a contrived one.
//
// Note what is NOT used here: `Prefer: status=415`. A client asking for a
// status is mockingham SERVING a declared response, not emitting an error, and
// normal rendering already generates it from the declared schema.
const doc = {
  openapi: '3.1.0',
  paths: {
    '/on-contract': {
      post: {
        operationId: 'onContract',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '200': { description: 'ok' },
          '415': {
            description: 'bad type',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['errorCode', 'detail'],
                  properties: {
                    errorCode: { type: 'string' },
                    detail: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    '/off-contract': {
      post: {
        operationId: 'offContract',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  }
}

const api = loadApi(doc)

function badType(path: string): Request {
  return new Request(`http://mock${path}`, {
    method: 'POST',
    body: '<xml/>',
    headers: { 'content-type': 'application/xml' }
  })
}

test('a declared error status is emitted in the operation shape', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(badType('/on-contract'))
  assert.equal(response.status, 415)
  const body = (await response.json()) as any
  // The operation's own schema, not the built-in envelope.
  assert.equal(typeof body.errorCode, 'string')
  assert.equal(typeof body.detail, 'string')
  assert.equal(body.error, undefined)
})

test('an undeclared error status falls back to the envelope', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(badType('/off-contract'))
  assert.equal(response.status, 415)
  assert.equal(
    ((await response.json()) as any).error.code,
    'MOCK_UNSUPPORTED_MEDIA_TYPE'
  )
})

test('a 404 always uses the envelope, having no operation to be on contract with', async () => {
  const handle = createHandler(api, { seed: 'contract' })
  const response = await handle(new Request('http://mock/nope'))
  assert.equal(response.status, 404)
  assert.equal(((await response.json()) as any).error.code, 'MOCK_NOT_FOUND')
})

test('diagnostic mode always uses the envelope', async () => {
  const handle = createHandler(api, { seed: 'contract', errorBody: 'diagnostic' })
  const response = await handle(badType('/on-contract'))
  assert.equal(
    ((await response.json()) as any).error.code,
    'MOCK_UNSUPPORTED_MEDIA_TYPE'
  )
})

test('contract mode still exposes the diagnostic on a debug header', async () => {
  const handle = createHandler(api, { seed: 'contract', debugHeaders: true })
  const response = await handle(badType('/on-contract'))
  assert.match(
    response.headers.get('x-mock-error') ?? '',
    /MOCK_UNSUPPORTED_MEDIA_TYPE/
  )
})

test('a custom errorBody function wins over both modes', async () => {
  const handle = createHandler(api, {
    seed: 'contract',
    errorBody: (_ctx, err) => ({ custom: err.code })
  })
  const response = await handle(badType('/on-contract'))
  assert.deepEqual(await response.json(), { custom: 'MOCK_UNSUPPORTED_MEDIA_TYPE' })
})
