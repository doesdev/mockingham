import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadApi } from '../../src/spec/load.ts'

const doc = JSON.parse(
  await readFile(new URL('../../docs/example.json', import.meta.url), 'utf8')
) as Record<string, unknown>

test('the example document loads and declares the operations the guides use', () => {
  const api = loadApi(doc)
  const ids = api.operations.map((operation) => operation.operationId).sort()
  assert.deepEqual(ids, [
    'createPayment',
    'createRefund',
    'getPayment',
    'listPayments'
  ])
})

test('it declares both security schemes the auth guide shows', () => {
  const api = loadApi(doc)
  assert.deepEqual(Object.keys(api.securitySchemes).sort(), [
    'apiKeyAuth',
    'bearerAuth'
  ])
})

test('createPayment declares the callback the webhook guide fires', () => {
  const api = loadApi(doc)
  const create = api.operations.find((o) => o.operationId === 'createPayment')
  assert.ok(create, 'createPayment must exist')
  assert.deepEqual(
    create.callbacks.map((callback) => callback.name),
    ['paymentSucceeded']
  )
})

test('a top-level webhook is declared for the failure path', () => {
  const api = loadApi(doc)
  // src/spec/load.ts deliberately folds every operation's callbacks into
  // api.webhooks too (a top-level entry wins on name collision), "so emit()
  // has one place to look rather than two" (see load.ts around the webhooks
  // merge loop). So api.webhooks holds both the top-level paymentFailed
  // webhook and the paymentSucceeded callback contributed by createPayment —
  // it is not top-level-only. See task-1-report.md for the full finding.
  assert.deepEqual(Object.keys(api.webhooks).sort(), [
    'paymentFailed',
    'paymentSucceeded'
  ])
})

test('every operation carries a tag, so the MCP search tools have something real', () => {
  const api = loadApi(doc)
  for (const operation of api.operations) {
    assert.ok(operation.tags.length > 0, `${operation.operationId} needs a tag`)
  }
})
