import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HTTP_METHODS } from '../src/spec/types.ts'

test('toolchain strips types and resolves .ts imports', () => {
  const methods: readonly string[] = HTTP_METHODS
  assert.ok(methods.includes('get'))
  assert.ok(methods.includes('delete'))
  assert.equal(methods.length, 7)
})
