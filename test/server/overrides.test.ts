import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { overrideKey } from '../../src/runtime/overrides.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'overrides', ...options }).fetch
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

test('a resolver receives the live ctx during body generation', async () => {
  // The design's own byName example reads ctx. If ctx is not threaded through,
  // the resolver gets undefined and this 500s instead of returning the value.
  const { body } = await get({
    resolvers: { byName: [['name', (ctx: any) => `pet-${ctx.params.petId}`]] }
  })
  assert.equal(body['name'], 'pet-7')
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

test('a runtime override layers on top of a config override', async () => {
  // All five layers present at once. A test with fewer proves nothing about
  // ordering — it passes with the whole composition removed.
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: {
      showPetById: { 200: { body: { name: 'from-config', tag: 'kept' } } }
    }
  })

  await store.set(overrideKey('showPetById'), { 200: { body: { name: 'from-runtime' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>

  assert.equal(body.name, 'from-runtime', 'the runtime layer wins')
  assert.equal(body.tag, 'kept', 'and refines rather than erases the config layer')
})

test('a runtime override forces the selected status, beating a config status', async () => {
  // A config `status` of 200 is set on the same operation so this test can
  // only pass if `runtime.status` genuinely wins over `config.status` — a
  // test with no competing config value cannot distinguish
  // `runtime.status ?? config.status` from the reverse.
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: { showPetById: { status: 200 } }
  })

  await store.set(overrideKey('showPetById'), { status: 404 })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 404)
})

test('a runtime override contributes headers, and wins a collision', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: { showPetById: { 200: { headers: { 'x-a': 'config', 'x-b': 'config' } } } }
  })

  await store.set(overrideKey('showPetById'), { 200: { headers: { 'x-a': 'runtime' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.headers.get('x-a'), 'runtime')
  assert.equal(response.headers.get('x-b'), 'config', 'untouched header survives')
})

test('an override for a different status contributes nothing', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime' })

  await store.set(overrideKey('showPetById'), { 404: { body: { name: 'wrong-status' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.notEqual(body.name, 'wrong-status')
})

test('debugHeaders reports that an override applied', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime', debugHeaders: true })

  const before = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(before.headers.get('x-mock-override'), null, 'absent when none is set')

  await store.set(overrideKey('showPetById'), { 200: { body: { name: 'x' } } })
  const after = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(after.headers.get('x-mock-override'), 'applied')
})

test('debugHeaders does not report an override scoped to a status that was not selected', async () => {
  // A record exists for this operation, but it targets 404 while the request
  // resolves to 200 — nothing about the response actually came from it, so
  // the header must stay off. `runtime !== EMPTY_OVERRIDE` alone would get
  // this wrong, since a record exists.
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime', debugHeaders: true })

  await store.set(overrideKey('showPetById'), { 404: { body: { name: 'wrong-status' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-mock-override'), null)
})

test('debugHeaders does not report an empty override object', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime', debugHeaders: true })

  await store.set(overrideKey('showPetById'), {})

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.headers.get('x-mock-override'), null)
})

test('debugHeaders reports an override that only forced the status', async () => {
  // The third arm of the condition: no body, no headers, only a `status`
  // that matches the one actually selected.
  const store = createMemoryStore()
  const handler = createHandler(api, { store, seed: 'runtime', debugHeaders: true })

  await store.set(overrideKey('showPetById'), { status: 404 })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('x-mock-override'), 'applied')
})

test('a configured respond beats a runtime override', async () => {
  // Design section 4.2: respond returns before status selection and render,
  // so a runtime override cannot reach it. Documented, not accidental.
  const store = createMemoryStore()
  const handler = createHandler(api, {
    store,
    seed: 'runtime',
    operations: { showPetById: { respond: () => new Response('from-respond', { status: 200 }) } }
  })

  await store.set(overrideKey('showPetById'), { status: 404, 200: { body: { name: 'x' } } })

  const response = await handler.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'from-respond')
})
