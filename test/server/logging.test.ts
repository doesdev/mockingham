import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { LogRecord } from '../../src/runtime/logging.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    },
    '/notes': {
      post: {
        operationId: 'createNote',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'created' } }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
})

function collector() {
  const records: LogRecord[] = []
  return { records, onLog: (record: LogRecord) => { records.push(record) } }
}

test('a short-circuited response is logged', async () => {
  // THE test this whole refactor exists for. A 401 never reaches the renderer,
  // so before the single exit there was nowhere to observe it — and a 401 is
  // exactly the record an operator most wants.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/pets/7'))

  assert.equal(sink.records.length, 1)
  const record = sink.records[0]!
  assert.equal(record.status, 401)
  assert.equal(record.route, '/pets/{id}')
  assert.equal(record.path, '/pets/7')
  assert.equal(record.operationId, 'getPet')
  assert.deepEqual(record.params, { id: '7' })
  assert.equal(record.decisions.auth, 'denied')
  // Auth answered first, so validation never ran and records nothing.
  assert.equal(record.decisions.validation, undefined)
})

test('an unmatched route is logged too', async () => {
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/nope'))

  const record = sink.records[0]!
  assert.equal(record.status, 404)
  assert.equal(record.route, '<unmatched>')
  assert.equal(record.path, '/nope')
  assert.equal(record.operationId, undefined)
})

test('a rendered response carries byte counts and ctx.log contributions', async () => {
  const sink = collector()
  const handle = createHandler(api, {
    seed: 'log',
    onLog: sink.onLog,
    operations: {
      getPet: {
        respond: (ctx) => {
          ctx.log['tenant'] = 'acme'
          return ctx.respond(200, { ok: true })
        }
      }
    }
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7?limit=2', { headers: { authorization: 'Bearer t' } })
  )
  const body = await response.text()

  const record = sink.records[0]!
  assert.equal(record.status, 200)
  assert.equal(record.bytesOut, new TextEncoder().encode(body).length)
  assert.deepEqual(record.query, { limit: '2' })
  assert.deepEqual(record.custom, { tenant: 'acme' })
  assert.equal(record.seed, 'log')
  assert.equal(record.requestId.length, 16)
})

test('durationMs is measured exactly under an injected clock', async () => {
  // The failure stage's `sleep` is injectable, so advancing the fake clock from
  // inside it produces an exact duration rather than a tolerance window.
  let value = 5_000
  const sink = collector()
  const handle = createHandler(api, {
    seed: 'log',
    now: () => value,
    sleep: async (ms) => { value += ms },
    // A bare '*' is an operationId matcher (matches nothing); '* /**' is the
    // actual match-everything target per resolve/target.ts's grammar.
    failure: [{ match: '* /**', latency: 42 }],
    onLog: sink.onLog
  }).fetch

  await handle(new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } }))

  const record = sink.records[0]!
  assert.equal(record.ts, 5_000)
  assert.equal(record.durationMs, 42)
})

test('a throwing logger does not affect the response', async () => {
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'log',
    onLog: () => { throw new Error('logger down') },
    onError: (error) => seen.push(error)
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } })
  )

  assert.equal(response.status, 200)
  assert.equal((seen[0] as Error).message, 'logger down')
})

test('an internal fault reaches onError and is still logged', async () => {
  const sink = collector()
  const seen: unknown[] = []
  const handle = createHandler(api, {
    seed: 'log',
    onLog: sink.onLog,
    onError: (error) => seen.push(error),
    operations: { getPet: { respond: () => { throw new Error('callback boom') } } }
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } })
  )

  assert.equal(response.status, 500)
  assert.equal((seen[0] as Error).message, 'callback boom')
  assert.equal(sink.records[0]!.status, 500)
  assert.equal(sink.records[0]!.error, 'callback boom')
})

test('bytesIn counts the raw request bytes, not its characters', async () => {
  // A multi-byte body is what separates a byte count from a string length. A
  // test with an ASCII body passes either way, and a bodyless GET passes with
  // bytesIn hardcoded to 0.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch
  const body = '{"note":"café"}'

  await handle(
    new Request('http://mock/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    })
  )

  assert.equal(new TextEncoder().encode(body).length, 16)
  assert.equal(body.length, 15)
  assert.equal(sink.records[0]!.bytesIn, 16)
})
