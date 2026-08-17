import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createHandler } from '../../src/server/handler.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { petstore } from '../fixtures/petstore.ts'
import type { Ctx } from '../../src/runtime/types.ts'

const api = loadApi(petstore)
const handler = createHandler(api, { seed: 'test' }).fetch

test('serves a generated object for a matched route', async () => {
  const res = await handler(new Request('http://x/pets/42'))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  const body = (await res.json()) as any
  assert.equal(typeof body.id, 'number')
  assert.equal(typeof body.name, 'string')
})

test('serves a generated array', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(res.status, 200)
  const body = (await res.json()) as any
  assert.ok(Array.isArray(body))
  assert.equal(typeof body[0].name, 'string')
})

test('is deterministic for the same request', async () => {
  const first = await (await handler(new Request('http://x/pets/42'))).json()
  const second = await (await handler(new Request('http://x/pets/42'))).json()
  assert.deepEqual(first, second)
})

test('differs across different path parameters', async () => {
  const a = await (await handler(new Request('http://x/pets/42'))).json()
  const b = await (await handler(new Request('http://x/pets/43'))).json()
  assert.notDeepEqual(a, b)
})
// If this assertion fails it is NOT flaky - generation is deterministic, so
// these two seeds genuinely collided on every field. Change 42/43 to two other
// ids and it will stay passing. Do not weaken the assertion.

test('returns 404 for an unknown path', async () => {
  const res = await handler(new Request('http://x/nope'))
  assert.equal(res.status, 404)
})

test('returns 405 with an Allow header for a known path', async () => {
  const res = await handler(new Request('http://x/pets/42', { method: 'DELETE' }))
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET')
})

test('a 405 carries both the Allow header and an error body', async () => {
  const handle = createHandler(loadApi(petstore), { seed: '405' }).fetch
  const response = await handle(
    new Request('http://mock/pets/7', { method: 'DELETE' })
  )
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET')
  assert.equal(((await response.json()) as any).error.code, 'MOCK_METHOD_NOT_ALLOWED')
})

test('selects the lowest declared 2xx', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
})

test('honors Prefer: status', async () => {
  const res = await handler(
    new Request('http://x/pets/42', { headers: { prefer: 'status=404' } })
  )
  assert.equal(res.status, 404)
})

test('generates spec-declared response headers', async () => {
  const res = await handler(new Request('http://x/pets'))
  assert.equal(typeof res.headers.get('x-next'), 'string')
})

test('emits debug headers when enabled', async () => {
  const debug = createHandler(api, { seed: 'test', debugHeaders: true }).fetch
  const res = await debug(new Request('http://x/pets/42'))
  assert.equal(res.headers.get('x-mock-operation'), 'showPetById')
  assert.ok(res.headers.get('x-mock-seed'))
})

test('a response with no content yields 204-style empty body', async () => {
  const res = await handler(new Request('http://x/pets', { method: 'POST' }))
  assert.equal(res.status, 201)
  assert.equal(await res.text(), '')
})

test('reset clears a caller-supplied store', async () => {
  const store = createMemoryStore()
  const handler = createHandler(api, { seed: 'reset', store })
  await store.set('left-behind', 1)

  await handler.reset()

  assert.equal(await store.get('left-behind'), undefined)
})

test('reset is awaitable', async () => {
  const handler = createHandler(api, { seed: 'reset' })
  assert.ok(handler.reset() instanceof Promise)
})

test('requestId is deterministic across handlers and distinct across calls', async () => {
  const echo = {
    seed: 'ids',
    operations: {
      // Reading ctx.requestId through a response callback is the only way to
      // observe it; nothing echoes it on a header by default.
      showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) }
    }
  }
  const idFrom = async (handle: (r: Request) => Promise<Response>) =>
    ((await (await handle(new Request('http://x/pets/42'))).json()) as { id: string }).id

  const first = createHandler(api, echo).fetch
  const one = await idFrom(first)
  const two = await idFrom(first)

  // A fresh handler with the same seed replays the same sequence - that is what
  // "stable across processes" means for a correlation id.
  const replay = await idFrom(createHandler(api, echo).fetch)

  assert.notEqual(one, two)
  assert.equal(replay, one)
})

test('an inbound X-Request-Id wins', async () => {
  const handle = createHandler(api, {
    seed: 'ids',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, { id: ctx.requestId }) } }
  }).fetch

  const response = await handle(
    new Request('http://x/pets/42', { headers: { 'x-request-id': 'caller-42' } })
  )

  assert.equal(((await response.json()) as { id: string }).id, 'caller-42')
})

test('the injected clock drives the default store', async () => {
  // Proves `now` actually reaches createMemoryStore rather than only the log
  // record: an outage armed with a TTL must expire when the clock advances.
  // The outage key is `outage|<operationId>` - see outageKey and targetKey in
  // src/runtime/failure.ts. No `failure` policy is needed: checkFailure reads
  // the outage key unconditionally, before it looks at any policy.
  let value = 1_000
  const handler = createHandler(api, { seed: 'clock', now: () => value })
  await handler.store.set('outage|showPetById', { status: 503 }, 5_000)

  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 503)
  value += 6_000
  assert.equal((await handler.fetch(new Request('http://x/pets/42'))).status, 200)
})

test('decisions are populated by the time a response callback runs', async () => {
  const handle = createHandler(api, {
    seed: 'decisions',
    operations: { showPetById: { respond: (ctx: Ctx) => ctx.respond(200, ctx.decisions) } }
  }).fetch

  const body = await (await handle(new Request('http://x/pets/42'))).json()

  // petstore declares no security, so auth is 'anonymous' rather than 'ok' -
  // a real outcome, not a missing one.
  assert.deepEqual(body, { auth: 'anonymous', validation: 'ok', failure: 'ok' })
})
