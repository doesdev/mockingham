import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFor, toolNamed } from './helpers.ts'

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
