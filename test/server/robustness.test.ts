import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'robust', ...options })
}

test('ctx.respond settles promises an async resolver left in the tree', async () => {
  const handle = handler({
    resolvers: { byFormat: { email: async () => 'async@example.com' } },
    operations: {
      showPetById: { respond: (ctx: any) => ctx.respond(200, ctx.generate()) }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  const text = await response.text()
  assert.doesNotMatch(text, /\{\}/, 'a promise serialized as an empty object')
  assert.doesNotMatch(text, /\[object Promise\]/)
  const body = JSON.parse(text) as Record<string, unknown>
  assert.equal(body['email'], 'async@example.com')
  assert.equal(typeof body['name'], 'string')
})

test('a throwing body override yields a 500 envelope rather than a rejection', async () => {
  const handle = handler({
    operations: {
      showPetById: {
        200: { body: { name: () => { throw new Error('sync boom') } } }
      }
    }
  })
  const promise = handle(new Request('http://mock/pets/7'))
  await assert.doesNotReject(promise)
  const response = await promise
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_CALLBACK_FAILED')
  assert.equal(body.error.message, 'sync boom')
})

test('a rejecting async body override yields the same 500 envelope', async () => {
  const handle = handler({
    operations: {
      showPetById: {
        200: { body: { name: async () => { throw new Error('async boom') } } }
      }
    }
  })
  const promise = handle(new Request('http://mock/pets/7'))
  await assert.doesNotReject(promise)
  const response = await promise
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_CALLBACK_FAILED')
  assert.equal(body.error.message, 'async boom')
})

test('a throwing header override yields a 500 rather than a rejection', async () => {
  const handle = handler({
    debugHeaders: true,
    operations: {
      showPetById: {
        200: { headers: { 'x-trace': () => { throw new Error('header boom') } } }
      }
    }
  })
  const promise = handle(new Request('http://mock/pets/7'))
  await assert.doesNotReject(promise)
  const response = await promise
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('x-mock-error'), 'header boom')
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_CALLBACK_FAILED')
})

test('a star override applies to every key of an object body', async () => {
  const handle = handler({
    operations: {
      showPetById: { 200: { body: { '*': 'X', name: 'kept' } } }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  const text = await response.text()
  assert.equal(text.includes('"*"'), false, 'a literal star key reached the body')
  const body = JSON.parse(text) as Record<string, unknown>
  // Every generated key took the wildcard, except the one addressed explicitly.
  assert.deepEqual(body, { id: 'X', name: 'kept', email: 'X', tag: 'X' })
  // And the wildcard invented nothing the generated object did not already have.
  assert.deepEqual(Object.keys(body), ['id', 'name', 'email', 'tag'])
})

test('a star override function receives each existing value', async () => {
  const handle = handler({
    operations: {
      showPetById: { 200: { body: { '*': (ctx: any) => typeof ctx.params.petId } } }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  const body = (await response.json()) as Record<string, unknown>
  assert.deepEqual(body, {
    id: 'string', name: 'string', email: 'string', tag: 'string'
  })
})

test('an internal failure is not reported as a callback failure', async () => {
  // A generate hook that throws is mockingham's own code path, not a user
  // callback, so it must not be labeled MOCK_CALLBACK_FAILED.
  const broken = loadApi(petstore)
  const target = broken.operations.find((o) => o.operationId === 'showPetById')
  // A schema whose `properties` is a primitive makes classify/generate throw.
  ;(target as any).responses[0].content['application/json'].schema = {
    get type(): string { throw new Error('internal boom') }
  }
  const handle = createHandler(broken, { seed: 'internal' })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_INTERNAL')
})
