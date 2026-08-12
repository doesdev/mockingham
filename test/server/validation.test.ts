import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

test('a +json body is negotiated, parsed, and validated end to end', async () => {
  const api = loadApi({
    openapi: '3.1.0',
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['age'],
                  properties: { age: { type: 'integer' } }
                }
              }
            }
          },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  })
  const handle = createHandler(api, { seed: 'suffix' }).fetch

  const send = (body: string) =>
    handle(new Request('http://mock/things', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/vnd.api+json' }
    }))

  // Negotiated and parsed rather than 415'd...
  assert.equal((await send('{"age":7}')).status, 200)
  // ...and actually validated, not merely waved through.
  const bad = await send('{"age":"old"}')
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as any).error.errors[0].path, 'body.age')
})

const api = loadApi(petstore)

test('a bad path param is a 400 with a flattened error list', async () => {
  const handle = createHandler(api, { seed: 'validate' }).fetch
  const response = await handle(new Request('http://mock/pets/abc'))
  assert.equal(response.status, 400)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_REQUEST_INVALID')
  assert.equal(body.error.errors[0].path, 'path.petId')
})

test('a valid request is unaffected', async () => {
  const handle = createHandler(api, { seed: 'validate' }).fetch
  assert.equal((await handle(new Request('http://mock/pets/7'))).status, 200)
})

test('validation can be turned off', async () => {
  const handle = createHandler(api, { seed: 'validate', validateRequests: false }).fetch
  assert.equal((await handle(new Request('http://mock/pets/abc'))).status, 200)
})

const withErrorSchema = loadApi({
  openapi: '3.1.0',
  paths: {
    '/strict/{id}': {
      get: {
        operationId: 'strict',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
        ],
        responses: {
          '200': { description: 'ok' },
          '400': {
            description: 'bad',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['errorCode'],
                  properties: { errorCode: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    }
  }
})

test('a contract-shaped 400 keeps its diagnostic on the debug header', async () => {
  // The validation list cannot go in the body without violating the schema the
  // client was told to expect, so it goes here instead.
  const handle = createHandler(withErrorSchema, { seed: 'v', debugHeaders: true }).fetch
  const response = await handle(new Request('http://mock/strict/abc'))
  assert.equal(response.status, 400)
  const body = (await response.json()) as any
  // On-contract: the operation's own shape, not the envelope.
  assert.equal(typeof body.errorCode, 'string')
  assert.equal(body.error, undefined)
  // ...and the diagnostic survives on the header.
  assert.match(response.headers.get('x-mock-error') ?? '', /path\.id/)
})

test('the envelope form still carries the flattened list in the body', async () => {
  const handle = createHandler(withErrorSchema, { seed: 'v', errorBody: 'diagnostic' }).fetch
  const response = await handle(new Request('http://mock/strict/abc'))
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_REQUEST_INVALID')
  assert.equal(body.error.errors[0].path, 'path.id')
})
