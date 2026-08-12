import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requestIdFor } from '../../src/runtime/logging.ts'

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
