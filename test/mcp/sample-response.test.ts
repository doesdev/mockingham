import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { contextFor, contextForMock, toolNamed } from './helpers.ts'
import { mcpDoc } from './doc.ts'

// getOrder and listOrders inherit the document's top-level `bearerAuth`
// requirement (doc.ts); createOrder overrides to `apiKeyAuth`. sample_response
// has no auth shortcut — it IS mock.fetch — so an unauthenticated request to
// either genuinely 401s, same as a real client would get. These constants
// supply the credential a real caller would send, so the tests below exercise
// generation behavior rather than the auth stage.
const BEARER = { authorization: 'Bearer test-token' }
const API_KEY = { 'x-api-key': 'test-key' }

test('sample_response returns exactly what mock.fetch returns', async () => {
  const mock = createMock(mcpDoc)
  const ctx = contextForMock(mock)

  const sample = (await toolNamed('sample_response').handler(ctx, {
    operationId: 'getOrder',
    params: { orderId: 'abc' },
    headers: BEARER
  })) as { status: number; body: unknown; url: string }

  const direct = await mock.fetch(
    new Request('http://mock.local/orders/abc', { headers: BEARER })
  )

  assert.equal(sample.status, direct.status)
  assert.deepEqual(sample.body, await direct.json())
  assert.equal(sample.url, 'http://mock.local/orders/abc')
})

test('sample_response synthesizes a missing path parameter that satisfies its schema', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder',
    headers: BEARER
  })) as { status: number; url: string }

  assert.equal(sample.status, 200)
  const orderId = new URL(sample.url).pathname.split('/').pop() as string
  // The document declares minLength 3; a synthesized value that violated it
  // would 400 under request validation and tell the agent nothing.
  assert.ok(orderId.length >= 3, `synthesized orderId "${orderId}" is too short`)
})

test('the same call twice is byte-identical', async () => {
  // Master spec section 17's determinism requirement, at this surface.
  const ctx = contextFor()
  const first = (await toolNamed('sample_response').handler(
    ctx, { operationId: 'getOrder', headers: BEARER }
  ))
  const second = (await toolNamed('sample_response').handler(
    ctx, { operationId: 'getOrder', headers: BEARER }
  ))

  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('a synthesized path parameter is stable across calls and across seeds', async () => {
  const first = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder'
  })) as { url: string }
  const second = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder'
  })) as { url: string }
  assert.equal(first.url, second.url)

  const reseeded = createMock(mcpDoc, { seed: 'a-totally-different-seed' })
  const third = (await toolNamed('sample_response').handler(contextForMock(reseeded), {
    operationId: 'getOrder'
  })) as { url: string }

  // A synthesized parameter is an address, not content: set_seed must change
  // what /orders/X returns, not turn it into /orders/Y. Design section 3.2.
  assert.equal(third.url, first.url)
})

test('the response body does change with the seed', async () => {
  const a = (await toolNamed('sample_response').handler(
    contextForMock(createMock(mcpDoc, { seed: 'seed-a' })),
    { operationId: 'getOrder', headers: BEARER }
  )) as { body: unknown }
  const b = (await toolNamed('sample_response').handler(
    contextForMock(createMock(mcpDoc, { seed: 'seed-b' })),
    { operationId: 'getOrder', headers: BEARER }
  )) as { body: unknown }

  assert.notDeepEqual(a.body, b.body)
})

test('sample_response honors a requested status', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'createOrder',
    status: 400,
    body: { id: 'x', total: 1 },
    headers: API_KEY
  })) as { status: number; body: Record<string, unknown> }

  assert.equal(sample.status, 400)
  assert.equal(typeof sample.body.message, 'string')
})

test('sample_response passes query parameters through', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'listOrders',
    query: { limit: 5 },
    headers: BEARER
  })) as { url: string; status: number }

  assert.equal(sample.status, 200)
  assert.ok(sample.url.endsWith('/orders?limit=5'), sample.url)
})
