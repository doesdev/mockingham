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
  // so before the single exit there was nowhere to observe it - and a 401 is
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

test('two 404s on different paths get distinct requestIds', async () => {
  // I4.1: `trace.requestKey` used to stay seeded to `seed` on the unmatched
  // path, so every 404/405 the process ever served shared one id - not even
  // distinct across different paths, let alone repeated calls to the same one.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/nope-a'))
  await handle(new Request('http://mock/nope-b'))

  const [first, second] = sink.records
  assert.notEqual(first!.requestId, second!.requestId)
})

test('two 404s on the same path also get distinct requestIds', async () => {
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/nope'))
  await handle(new Request('http://mock/nope'))

  const [first, second] = sink.records
  assert.notEqual(first!.requestId, second!.requestId)
})

test('a 405 logs the route it matched on segments, but no operationId', async () => {
  // I4.3: the router knows the templated path even though no single Operation
  // answered - the method was wrong, not the route. operationId stays
  // undefined because it genuinely differs by method here.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch

  await handle(new Request('http://mock/pets/7', { method: 'DELETE' }))

  const record = sink.records[0]!
  assert.equal(record.status, 405)
  assert.equal(record.route, '/pets/{id}')
  assert.equal(record.operationId, undefined)
})

test('bytesIn is counted on a body-parse failure, not left at zero', async () => {
  // I4.2: the bytes were fully read to even discover the parse failure - a
  // 415/400 storm must not log as zero traffic.
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch
  const body = '{not json'

  await handle(
    new Request('http://mock/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    })
  )

  const record = sink.records[0]!
  assert.equal(record.status, 400)
  assert.equal(record.bytesIn, new TextEncoder().encode(body).length)
})

test('two body-parse failures for the same operation get distinct requestIds', async () => {
  const sink = collector()
  const handle = createHandler(api, { seed: 'log', onLog: sink.onLog }).fetch
  const bad = () =>
    new Request('http://mock/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    })

  await handle(bad())
  await handle(bad())

  const [first, second] = sink.records
  assert.notEqual(first!.requestId, second!.requestId)
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

test('a throw while assembling the log record cannot reach the caller', async () => {
  // Deferred item 20: the log block's own try/catch was untested, on the
  // grounds that nothing inside it could realistically throw now that
  // `emitLog` self-isolates. That is true of the SINK - and it is not true of
  // the block, which reads the clock for `durationMs` inside the same guard.
  // An untested guard is indistinguishable from an absent one.
  const errors: unknown[] = []
  let reads = 0
  const handle = createHandler(api, {
    seed: 'log',
    // Survives the guarded read at the start of the exit, then throws on the
    // second read, which is the one inside the log block.
    now: () => {
      reads += 1
      if (reads > 1) throw new Error('clock boom')
      return 1_000
    },
    onLog: () => {},
    onError: (error) => errors.push(error)
  }).fetch

  const response = await handle(
    new Request('http://mock/pets/7', { headers: { authorization: 'Bearer t' } })
  )

  assert.equal(response.status, 200, 'the response the caller already earned')
  assert.equal((errors[0] as Error).message, 'clock boom')
})
