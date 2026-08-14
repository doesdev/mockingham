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
  // it — which is exactly the misconfiguration worth telling an agent about.
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
