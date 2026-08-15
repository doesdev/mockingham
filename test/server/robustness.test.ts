import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'robust', ...options }).fetch
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
  const handle = createHandler(broken, { seed: 'internal' }).fetch
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_INTERNAL')
})

test('a synchronously throwing resolver is a callback failure', async () => {
  const handle = createHandler(loadApi(petstore), {
    seed: 'resolver-throw',
    resolvers: { byName: [['name', () => { throw new Error('resolver boom') }]] }
  }).fetch
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as any
  assert.equal(body.error.code, 'MOCK_CALLBACK_FAILED')
  assert.match(body.error.message, /resolver boom/)
})

test('a throwing auth verify is a callback failure', async () => {
  const doc = {
    openapi: '3.1.0',
    paths: { '/g': { get: { operationId: 'g', security: [{ b: [] }], responses: { '200': { description: 'ok' } } } } },
    components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } }
  }
  const handle = createHandler(loadApi(doc), {
    seed: 'verify-throw',
    auth: { b: { verify: () => { throw new Error('verify boom') } } }
  }).fetch
  const response = await handle(
    new Request('http://mock/g', { headers: { authorization: 'Bearer x' } })
  )
  assert.equal(response.status, 500)
  assert.equal(((await response.json()) as any).error.code, 'MOCK_CALLBACK_FAILED')
})

test('a throwing errorBody function is a callback failure', async () => {
  const handle = createHandler(loadApi(petstore), {
    seed: 'errorbody-throw',
    errorBody: () => { throw new Error('errorBody boom') }
  }).fetch
  // /pets/abc fails validation, which routes through the error builder.
  const response = await handle(new Request('http://mock/pets/abc'))
  assert.equal(response.status, 500)
  assert.equal(((await response.json()) as any).error.code, 'MOCK_CALLBACK_FAILED')
})

test('an async resolver that rejects is also a callback failure', async () => {
  const handle = createHandler(loadApi(petstore), {
    seed: 'resolver-reject',
    resolvers: { byName: [['name', async () => { throw new Error('async boom') }]] }
  }).fetch
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  assert.equal(((await response.json()) as any).error.code, 'MOCK_CALLBACK_FAILED')
})

/** Chaos outcomes across a spread of requests, as a comparable signature. */
function chaosOutcomes(handler: (request: Request) => Promise<Response>) {
  return Promise.all(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(async (id) =>
      (await handler(new Request(`http://mock/pets/${id}`))).status
    )
  )
}

const chaosOptions = {
  seed: 'robust',
  failure: [{ match: '* /**', rate: 0.5, respond: 503 }]
}

test('setSeed updates a chaos seed that merely defaulted to the seed', async () => {
  // Deferred item 8: `chaosSeed` defaulted to the seed and was captured once
  // at construction, so `setSeed` never reached it.
  //
  // The obvious test — reseed and watch the outcomes change — CANNOT FAIL:
  // `requestKey` carries the seed, so the chaos roll changes either way. That
  // is the entry's own reason for calling this cosmetic, and it passed against
  // the unfixed code when tried. Verified by mutation.
  //
  // What discriminates is comparing against a handler BUILT with the new seed.
  // Both then have the same `seed` and therefore the same request keys, so any
  // difference is the chaos seed alone: fixed, it matches; unfixed, the
  // reseeded handler keeps chaos-seeding on the old value and diverges.
  const reseeded = createHandler(api, chaosOptions)
  reseeded.setSeed('second-seed')

  const built = createHandler(api, { ...chaosOptions, seed: 'second-seed' })

  assert.deepEqual(
    await chaosOutcomes(reseeded.fetch),
    await chaosOutcomes(built.fetch),
    'after setSeed, chaos must roll as though the handler had been built with it'
  )
})

test('an explicitly configured chaosSeed is not recoupled by setSeed', async () => {
  // Decoupling is a deliberate choice — a run that wants stable chaos while
  // reshuffling content sets both — so setSeed must leave a configured one be.
  // Compared against a handler built with the new seed and the SAME pinned
  // chaos seed, which is what "left alone" means.
  const reseeded = createHandler(api, { ...chaosOptions, chaosSeed: 'pinned' })
  reseeded.setSeed('second-seed')

  const built = createHandler(api, {
    ...chaosOptions,
    seed: 'second-seed',
    chaosSeed: 'pinned'
  })

  assert.deepEqual(
    await chaosOutcomes(reseeded.fetch),
    await chaosOutcomes(built.fetch)
  )
})

test('an injected clock that throws still produces a response', async () => {
  // `const startedAt = now()` was the FIRST line of the single exit and sat
  // outside every catch, so a throwing clock rejected fetch() with no
  // response at all — the last hole in the response-always-returned
  // guarantee (deferred item 16).
  const errors: unknown[] = []
  const handle = createHandler(api, {
    seed: 'robust',
    now: () => { throw new Error('clock boom') },
    onError: (error) => errors.push(error)
  }).fetch

  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 200, 'a working request must still be answered')
  assert.equal((errors[0] as Error).message, 'clock boom')
})

test('a throwable whose toString throws still produces a response', async () => {
  // `String(error)` in internalError() invokes caller-supplied code. A value
  // whose toString throws escaped the boundary 500 itself.
  const hostile = {
    toString() { throw new Error('toString boom') }
  }
  const handle = createHandler(api, {
    seed: 'robust',
    onError: () => {},
    operations: {
      showPetById: { respond: () => { throw hostile } }
    }
  }).fetch

  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 500)
  const body = (await response.json()) as { error: { code: string; message: string } }
  // Described rather than propagated: the message says what happened instead
  // of the request failing to produce a response at all.
  assert.match(body.error.message, /unstringifiable/)
})
