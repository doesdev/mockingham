import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestIdFor, emitLog, reportError } from '../../src/runtime/logging.ts'
import type { LogRecord } from '../../src/runtime/logging.ts'

test('requestIdFor is stable for the same key and ordinal', () => {
  assert.equal(requestIdFor('k', 1), requestIdFor('k', 1))
})

test('requestIdFor differs across ordinals', () => {
  assert.notEqual(requestIdFor('k', 1), requestIdFor('k', 2))
})

test('requestIdFor differs across keys', () => {
  assert.notEqual(requestIdFor('a', 1), requestIdFor('b', 1))
})

test('requestIdFor is 16 lowercase hex characters', () => {
  assert.match(requestIdFor('k', 1), /^[0-9a-f]{16}$/)
  // A short hash left-pads rather than truncating; assert a key whose hash has
  // a leading zero still fills the width.
  for (let n = 1; n < 200; n++) {
    assert.match(requestIdFor(`key-${n}`, n), /^[0-9a-f]{16}$/)
  }
})

const record = (): LogRecord => ({
  ts: 0, durationMs: 0, requestId: 'r', method: 'GET', route: '/x', path: '/x',
  status: 200, bytesIn: 0, bytesOut: 0, params: {}, query: {}, seed: 's',
  decisions: {}, custom: {}
})

test('emitLog does nothing without a sink', () => {
  assert.doesNotThrow(() => emitLog(undefined, record()))
})

test('emitLog isolates a throwing sink', () => {
  const seen: unknown[] = []
  assert.doesNotThrow(() =>
    emitLog(() => { throw new Error('sink exploded') }, record(), (error) => seen.push(error))
  )
  assert.equal((seen[0] as Error).message, 'sink exploded')
})

test('emitLog isolates a rejecting sink', async () => {
  // An explicit .catch(), not a floating promise: an unhandled rejection can
  // take the process down, which is the opposite of error isolation.
  const seen: unknown[] = []
  emitLog(async () => { throw new Error('async explosion') }, record(), (error) => seen.push(error))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((seen[0] as Error).message, 'async explosion')
})

test('emitLog survives a throwing error sink', () => {
  assert.doesNotThrow(() =>
    emitLog(() => { throw new Error('a') }, record(), () => { throw new Error('b') })
  )
})

test('emitLog does not await the sink', () => {
  // Fire-and-forget: a slow logger must not delay the response.
  let settled = false
  emitLog(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    settled = true
  }, record())
  assert.equal(settled, false)
})

test('reportError isolates a throwing handler', () => {
  assert.doesNotThrow(() => reportError(() => { throw new Error('x') }, new Error('y')))
})
