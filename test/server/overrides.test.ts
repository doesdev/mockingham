import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'overrides', ...options })
}

async function get(options: object, path = '/pets/7') {
  const response = await handler(options)(new Request(`http://mock${path}`))
  // Read as text first: a 404 or 204 has no body, and Response.json() rejects
  // on an empty one.
  const text = await response.text()
  const body = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>
  return { response, body }
}

test('a static body override replaces one property', async () => {
  const { body } = await get({
    operations: { 'GET /pets/{petId}': { 200: { body: { name: 'Fixed' } } } }
  })
  assert.equal(body['name'], 'Fixed')
  assert.equal(typeof body['id'], 'number')
})

test('an override function receives ctx with the path params', async () => {
  const { body } = await get({
    operations: {
      'GET /pets/{petId}': { 200: { body: { id: (ctx: any) => Number(ctx.params.petId) } } }
    }
  })
  assert.equal(body['id'], 7)
})

test('an async override is awaited', async () => {
  const { body } = await get({
    operations: { 'GET /pets/{petId}': { 200: { body: { name: async () => 'Async' } } } }
  })
  assert.equal(body['name'], 'Async')
})

test('a byFormat resolver applies without any per-operation config', async () => {
  const { body } = await get({ resolvers: { byFormat: { email: () => 'a@b.c' } } })
  assert.equal(body['email'], 'a@b.c')
})

test('a bySchema resolver applies through the schema name table', async () => {
  const { body } = await get({ resolvers: { bySchema: { Pet: { name: () => 'Rex' } } } })
  assert.equal(body['name'], 'Rex')
})

test('an operation override beats a resolver', async () => {
  const { body } = await get({
    resolvers: { byName: [['name', () => 'from-resolver']] },
    operations: { 'GET /pets/{petId}': { 200: { body: { name: 'from-operation' } } } }
  })
  assert.equal(body['name'], 'from-operation')
})

test('a wildcard target matches several operations', async () => {
  const { body } = await get({
    operations: { '* /pets/**': { 200: { body: { name: 'Wild' } } } }
  })
  assert.equal(body['name'], 'Wild')
})

test('an operationId target works', async () => {
  const { body } = await get({
    operations: { showPetById: { 200: { body: { name: 'ById' } } } }
  })
  assert.equal(body['name'], 'ById')
})

test('a broad target then a specific one layer in declaration order', async () => {
  const { body } = await get({
    operations: {
      '* /pets/**': { 200: { body: { name: 'Broad', tag: 'Broad' } } },
      'GET /pets/{petId}': { 200: { body: { name: 'Specific' } } }
    }
  })
  assert.equal(body['name'], 'Specific')
  assert.equal(body['tag'], 'Broad')
})

test('a target matching nothing throws at construction', () => {
  assert.throws(
    () => handler({ operations: { 'GET /nope': { 200: { body: {} } } } }),
    /matches no operation/
  )
})

test('a header override reaches the response', async () => {
  const { response } = await get({
    operations: {
      'GET /pets/{petId}': { 200: { headers: { 'x-rate-limit-remaining': () => 99 } } }
    }
  })
  assert.equal(response.headers.get('x-rate-limit-remaining'), '99')
})

test('global header defaults apply to every operation', async () => {
  const { response } = await get({ headers: { 'x-env': 'test' } })
  assert.equal(response.headers.get('x-env'), 'test')
})

test('content-type is not overridable', async () => {
  const { response } = await get({ headers: { 'content-type': 'text/plain' } })
  assert.equal(response.headers.get('content-type'), 'application/json')
})

test('a static status override selects a different declared response', async () => {
  const { response } = await get({
    operations: { 'GET /pets/{petId}': { status: 404 } }
  })
  assert.equal(response.status, 404)
})

test('a request body is parsed and reaches ctx', async () => {
  const seen: unknown[] = []
  const handle = handler({
    operations: {
      createPet: { 201: { body: { echoed: (ctx: any) => { seen.push(ctx.body); return true } } } }
    }
  })
  await handle(new Request('http://mock/pets', {
    method: 'POST',
    body: '{"name":"Rex"}',
    headers: { 'content-type': 'application/json' }
  }))
  assert.deepEqual(seen[0], { name: 'Rex' })
})

test('generation is unchanged when nothing is configured', async () => {
  const plain = await get({})
  const also = await get({})
  assert.deepEqual(plain.body, also.body)
})
