import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMultipleOf, arrayLength, numberBounds, stringLength
} from '../../src/generate/constraints.ts'

test('number bounds default when unconstrained', () => {
  assert.deepEqual(numberBounds({}), { min: 0, max: 1000 })
})

test('number bounds honour minimum and maximum', () => {
  assert.deepEqual(numberBounds({ minimum: 5, maximum: 9 }), { min: 5, max: 9 })
})

test('number bounds honour numeric exclusive bounds', () => {
  assert.deepEqual(
    numberBounds({ exclusiveMinimum: 5, exclusiveMaximum: 9 }),
    { min: 6, max: 8 }
  )
})

test('number bounds honour boolean exclusive bounds from 3.0', () => {
  assert.deepEqual(
    numberBounds({ minimum: 5, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: true }),
    { min: 6, max: 8 }
  )
})

test('applyMultipleOf snaps up into range', () => {
  assert.equal(applyMultipleOf(7, { multipleOf: 5 }), 5)
  assert.equal(applyMultipleOf(7, { multipleOf: 5, minimum: 6 }), 10)
  assert.equal(applyMultipleOf(7, {}), 7)
})

test('string length defaults and honours bounds', () => {
  assert.deepEqual(stringLength({}), { min: 5, max: 12 })
  assert.deepEqual(stringLength({ minLength: 2, maxLength: 4 }), { min: 2, max: 4 })
})

test('string length keeps max at or above min', () => {
  assert.deepEqual(stringLength({ minLength: 20 }), { min: 20, max: 20 })
})

test('array length defaults and honours bounds', () => {
  assert.deepEqual(arrayLength({}), { min: 1, max: 3 })
  assert.deepEqual(arrayLength({ minItems: 4, maxItems: 6 }), { min: 4, max: 6 })
})

test('array length keeps max at or above min', () => {
  assert.deepEqual(arrayLength({ minItems: 8 }), { min: 8, max: 8 })
})
