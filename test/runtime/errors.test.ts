import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelope, isCallbackError, markCallback } from '../../src/runtime/errors.ts'

test('envelope has the project error shape', () => {
  assert.deepEqual(envelope('MOCK_X', 'boom'), {
    error: { code: 'MOCK_X', message: 'boom' }
  })
})

test('an unmarked error is not a callback error', () => {
  assert.equal(isCallbackError(new Error('boom')), false)
})

test('a marked error is a callback error', () => {
  assert.equal(isCallbackError(markCallback(new Error('boom'))), true)
})

test('marking returns the same error object', () => {
  const error = new Error('boom')
  assert.strictEqual(markCallback(error), error)
})

test('marking a non-object is safe and stays unmarked', () => {
  assert.equal(markCallback('boom'), 'boom')
  assert.equal(isCallbackError('boom'), false)
  assert.equal(isCallbackError(null), false)
  assert.equal(isCallbackError(undefined), false)
})
