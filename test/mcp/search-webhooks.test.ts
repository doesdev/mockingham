import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { contextFor, contextForMock, toolNamed } from './helpers.ts'
import { mcpDoc } from './doc.ts'

test('search_operations matches path, summary, description, and tags', async () => {
  const bySummary = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'place an order' }
  )) as Array<{ operationId?: string }>
  assert.equal(bySummary[0]?.operationId, 'createOrder')

  const byTag = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'ops' }
  )) as Array<{ operationId?: string }>
  assert.ok(byTag.some((entry) => entry.operationId === 'health'))

  const byDescription = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'every order the caller' }
  )) as Array<{ operationId?: string }>
  assert.equal(byDescription[0]?.operationId, 'listOrders')
})

test('search_operations is case-insensitive and honors limit', async () => {
  const result = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'ORDER', limit: 2 }
  )) as unknown[]
  assert.equal(result.length, 2)
})

test('search_operations returns an empty array rather than erroring on no match', async () => {
  const result = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'zzzz-no-such-thing' }
  )) as unknown[]
  assert.deepEqual(result, [])
})

test('list_webhooks reports declared webhooks and callbacks with their payload schemas', async () => {
  const result = (await toolNamed('list_webhooks').handler(contextFor(), {})) as Array<{
    name: string
    kind: string
    emittedBy: string[]
    payloadSchema?: Record<string, unknown>
    expression?: string
  }>

  const created = result.find((entry) => entry.name === 'orderCreated')
  assert.equal(created?.kind, 'webhook')
  assert.deepEqual(created?.payloadSchema?.required, ['id'])

  const shipped = result.find((entry) => entry.name === 'orderShipped')
  assert.equal(shipped?.kind, 'callback')
  assert.deepEqual(shipped?.emittedBy, ['POST /orders'])
  assert.equal(shipped?.expression, '{$request.body#/callbackUrl}')
})

test('list_webhooks reports an empty emittedBy for a webhook nothing fires', async () => {
  const result = (await toolNamed('list_webhooks').handler(contextFor(), {})) as Array<{
    name: string
    emittedBy: string[]
  }>

  // Honest and useful: the document declares it, but no operation config emits
  // it - which is exactly the misconfiguration worth telling an agent about.
  assert.deepEqual(result.find((entry) => entry.name === 'orderCreated')?.emittedBy, [])
})

test('list_webhooks reflects the configured emitters', async () => {
  const options = {
    operations: { 'POST /orders': { emits: [{ webhook: 'orderCreated' }] } },
    webhooks: { orderCreated: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(mcpDoc, options)
  const result = (await toolNamed('list_webhooks').handler(
    contextForMock(mock, options), {}
  )) as Array<{ name: string; emittedBy: string[] }>

  assert.deepEqual(result.find((entry) => entry.name === 'orderCreated')?.emittedBy, ['POST /orders'])
})

test('a callback keeps its declaring operation when a configured emitter exists', async () => {
  // Deferred item 29b. `emittedBy` reported the declaring operation only when
  // NOTHING was configured, so the moment any operation's `emits` named the
  // webhook, the operation that actually declares it disappeared from the
  // list - even when it was not among the configured emitters.
  //
  // `read.test.ts` pins the same ordering on a different document. Both cycles
  // closed 29b and ordered the result differently; declarer-first was settled
  // at the 2026-08-25 merge, so the two files must agree and both assert it.
  const options = {
    operations: { 'GET /orders/{orderId}': { emits: [{ webhook: 'orderShipped' }] } },
    webhooks: { orderShipped: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(mcpDoc, options)
  const result = (await toolNamed('list_webhooks').handler(
    contextForMock(mock, options), {}
  )) as Array<{ name: string; emittedBy: string[] }>

  const shipped = result.find((entry) => entry.name === 'orderShipped')
  // The declaring operation first, then the configured emitter. Both, not one.
  assert.deepEqual(shipped?.emittedBy, ['POST /orders', 'GET /orders/{orderId}'])
})

test('a recursive webhook payload is reported, not dropped', async () => {
  // Deferred item 29c said `listWebhooks` bypassing the `$comment` fallback
  // meant "a recursive webhook payload comes back as payloadSchema: undefined".
  // That premise is FALSE, and probing it is what showed so: zod expresses
  // recursion through `$defs`/`$ref`, exactly as `json-schema.ts`'s own
  // docstring says ("Recursion is NOT such a case"). Nothing this loader can
  // build was found to make the converter refuse.
  //
  // The routing fix still landed - every other tool goes through the helper
  // and the asymmetry was real - but it changes no observable output, so this
  // test asserts what IS true rather than a placeholder that never appears.
  const recursiveDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {},
    webhooks: {
      treeChanged: {
        post: {
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Node' } }
            }
          },
          responses: { '200': { description: 'ok' } }
        }
      }
    },
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }
          }
        }
      }
    }
  }

  const result = (await toolNamed('list_webhooks').handler(
    contextFor(recursiveDoc), {}
  )) as Array<{ name: string; payloadSchema?: Record<string, unknown> }>

  const entry = result.find((candidate) => candidate.name === 'treeChanged')
  assert.notEqual(entry?.payloadSchema, undefined, 'a recursive payload is expressible')
})

test('a declaring operation that is also configured is listed once', async () => {
  const options = {
    operations: { 'POST /orders': { emits: [{ webhook: 'orderShipped' }] } },
    webhooks: { orderShipped: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(mcpDoc, options)
  const result = (await toolNamed('list_webhooks').handler(
    contextForMock(mock, options), {}
  )) as Array<{ name: string; emittedBy: string[] }>

  assert.deepEqual(
    result.find((entry) => entry.name === 'orderShipped')?.emittedBy,
    ['POST /orders'],
    'a union, not a concatenation'
  )
})

test('list_deliveries filters by webhook and by outcome', async () => {
  const mock = createMock(mcpDoc, {
    webhooks: { orderCreated: { url: 'https://example.test/hook' } },
    captureOnly: true
  })
  await mock.emit('orderCreated')
  await mock.settled()

  const ctx = contextForMock(mock)
  const all = (await toolNamed('list_deliveries').handler(ctx, {})) as unknown[]
  assert.equal(all.length, 1)

  const matching = (await toolNamed('list_deliveries').handler(
    ctx, { webhook: 'orderCreated' }
  )) as unknown[]
  assert.equal(matching.length, 1)

  const other = (await toolNamed('list_deliveries').handler(
    ctx, { webhook: 'somethingElse' }
  )) as unknown[]
  assert.deepEqual(other, [])

  const wrongOutcome = (await toolNamed('list_deliveries').handler(
    ctx, { outcome: 'unresolved' }
  )) as unknown[]
  assert.deepEqual(wrongOutcome, [])
})
