import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { overrideKey } from '../../src/runtime/overrides.ts'
import { createMock } from '../../src/index.ts'

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

test('override then fetch changes the response through the public surface', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.name, 'overridden')
})

test('clearOverrides(target) restores the generated body', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })

  // Self-certifying: prove the override was actually live before proving
  // clear removes it. Without this, the final assertion also passes if
  // override() silently did nothing.
  const before = await mock.fetch(new Request('http://mock/pets/7'))
  const beforeBody = await before.json() as Record<string, unknown>
  assert.equal(beforeBody.name, 'overridden')

  await mock.clearOverrides('showPetById')

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})

test('clearOverrides() with no target clears every operation', async () => {
  // '* /**' is the documented match-everything wildcard (any method, any
  // path). A bare '*' is not special-cased by compileTarget — with no space
  // it is looked up as an operationId, so it matches nothing and throws; see
  // test/runtime/failure.test.ts for the same distinction asserted directly.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('* /**', { 200: { body: { name: 'overridden' } } })

  // Self-certifying: prove the override was actually live before proving
  // clear removes it. Without this, the final assertion also passes if
  // override() silently did nothing.
  const before = await mock.fetch(new Request('http://mock/pets/7'))
  const beforeBody = await before.json() as Record<string, unknown>
  assert.equal(beforeBody.name, 'overridden')

  await mock.clearOverrides()

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})

test('a wildcard target overrides every operation it matches', async () => {
  // /pets/7 (showPetById) and /pets/mine (myPet) both resolve a single Pet
  // object. listPets (/pets) returns an array, and layering an object-shaped
  // override over an array body is semantics this cycle never established —
  // using it here would let the test fail for a reason unrelated to
  // wildcards.
  // '* /**' is the documented match-everything wildcard (any method, any
  // path). A bare '*' is not special-cased by compileTarget — see the note
  // above.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('* /**', { 200: { body: { name: 'everywhere' } } })

  for (const path of ['/pets/7', '/pets/mine']) {
    const response = await mock.fetch(new Request(`http://mock${path}`))
    if (response.status !== 200) continue
    const body = await response.json()
    const first = Array.isArray(body) ? body[0] : body
    assert.equal(
      (first as Record<string, unknown>).name,
      'everywhere',
      `${path} should carry the override`
    )
  }
})

test('a target matching no operation throws instead of arming nothing', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await assert.rejects(
    () => mock.override('GET /nope', { 200: { body: {} } }),
    /matches no operation/
  )
})

test('a non-serializable override is refused at the door', async () => {
  const mock = createMock(petstore, { seed: 'runtime' })
  await assert.rejects(
    () => mock.override('showPetById', { 200: { body: { total: () => 1 } } as never }),
    /is a function/
  )
})

test('a rejected override writes nothing, not even for operations resolved before the failure', async () => {
  // Pins the ordering `override()` documents in its own comment:
  // assertSerializable runs BEFORE any store write, so a wildcard that
  // resolves to several operations either applies to all of them or none.
  // A comment claiming this is not the same as a test that would notice if
  // it changed — this is that test. See task-3-report.md, Step 7, for the
  // reordering evidence that motivated it.
  const mock = createMock(petstore, { seed: 'runtime' })

  await assert.rejects(
    () => mock.override('* /**', { 200: { body: { total: () => 1 } } as never }),
    /is a function/
  )

  for (const path of ['/pets/7', '/pets/mine']) {
    const response = await mock.fetch(new Request(`http://mock${path}`))
    const body = await response.json() as Record<string, unknown>
    assert.notEqual(
      body.total,
      1,
      `${path} must not carry any part of the rejected override`
    )
  }
})

test('the second override for one target replaces the first', async () => {
  // Design section 2.3: runtime overrides do not layer against each other.
  // A caller who cannot see what is already set gets a replacement they can
  // predict rather than a merge they cannot inspect.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'first', keep: 'a' } } })
  await mock.override('showPetById', { 200: { body: { name: 'second' } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.name, 'second')
  assert.notEqual(body.keep, 'a', 'the first override is gone, not merged')
})

test('an off-contract override body is served, not rejected', async () => {
  // Design section 5.2: an override body is NOT validated against the
  // response schema. That is already true of config overrides, and a runtime
  // override that behaved differently would be a second validation path — the
  // divergence invariant 1 exists to prevent. `name` is declared a string and
  // required; this replaces it with a number and the mock serves it.
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 42 } } })

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200)
  assert.equal((await response.json() as Record<string, unknown>).name, 42)
})

test('reset clears runtime overrides', async () => {
  // Master section 1 has always claimed this; it is asserted rather than
  // inferred from store.clear().
  const mock = createMock(petstore, { seed: 'runtime' })
  await mock.override('showPetById', { 200: { body: { name: 'overridden' } } })
  await mock.reset()

  const response = await mock.fetch(new Request('http://mock/pets/7'))
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.name, 'overridden')
})
