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

import { buildError } from '../../src/runtime/errors.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { Operation } from '../../src/spec/types.ts'

const bare: Operation = {
  method: 'get', path: '/x', parameters: [], responses: []
}

test('buildError uses the envelope when nothing is declared', async () => {
  const response = await buildError({
    operation: bare, status: 500, code: 'MOCK_X', message: 'boom',
    mode: 'contract', rng: createRng('e'), generateOptions: {}
  })
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    error: { code: 'MOCK_X', message: 'boom' }
  })
})

test('buildError with no operation uses the envelope', async () => {
  const response = await buildError({
    operation: undefined, status: 404, code: 'MOCK_NOT_FOUND', message: 'gone',
    mode: 'contract', rng: createRng('e'), generateOptions: {}
  })
  assert.equal(((await response.json()) as any).error.code, 'MOCK_NOT_FOUND')
})
