import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFor, toolNamed } from './helpers.ts'

/**
 * `list_operations` only. The read tools are split across several files by
 * subject: `describe.test.ts` (describe_operation and the identify-an-operation
 * rule), `search-webhooks.test.ts` (search_operations, list_webhooks),
 * `fixture-tools.test.ts` (list_fixtures, regenerate_fixture) and
 * `read.test.ts` (the capability fields, list_registrations, and the webhook
 * payload conversions).
 *
 * Was `tools-read.test.ts`, a name that said nothing `read.test.ts` did not
 * also say. The two arrived from opposite sides of the 2026-08-25 merge and
 * sitting side by side made neither findable.
 */

test('list_operations returns every operation in document order', async () => {
  const result = (await toolNamed('list_operations').handler(contextFor(), {})) as
    Array<{ method: string; path: string; operationId?: string; summary?: string; tags: string[] }>

  assert.deepEqual(
    result.map((entry) => `${entry.method} ${entry.path}`),
    ['GET /orders', 'POST /orders', 'GET /orders/{orderId}', 'GET /health']
  )
  assert.deepEqual(result[0]?.tags, ['orders', 'read'])
  assert.equal(result[0]?.summary, 'List all orders')
})

test('list_operations filters by tag', async () => {
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { tag: 'write' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(result.map((entry) => entry.operationId), ['createOrder'])
})

test('list_operations filters by path prefix', async () => {
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { pathPrefix: '/orders' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(
    result.map((entry) => entry.operationId),
    ['listOrders', 'createOrder', 'getOrder']
  )
})

test('list_operations applies tag and prefix together', async () => {
  // `tag: 'write'` alone matches only createOrder (path /orders); `pathPrefix:
  // '/orders/'` alone matches only getOrder (path /orders/{orderId}). Neither
  // operation satisfies both, so a correct AND yields nothing - chosen so
  // that a broken tag filter (still narrowed by prefix to getOrder) or a
  // broken prefix filter (still narrowed by tag to createOrder) each produce
  // a nonempty result and fail this assertion, unlike a same-direction pair
  // where one filter's result is already a subset of the other's.
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { tag: 'write', pathPrefix: '/orders/' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(result.map((entry) => entry.operationId), [])
})
