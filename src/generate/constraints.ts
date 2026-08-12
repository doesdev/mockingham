import type { Schema } from '../spec/types.ts'

const DEFAULT_NUMBER_MIN = 0
const DEFAULT_NUMBER_MAX = 1000
const DEFAULT_STRING_MIN = 5
const DEFAULT_STRING_MAX = 12
const DEFAULT_ARRAY_MIN = 1
const DEFAULT_ARRAY_MAX = 3

export function numberBounds(schema: Schema): { min: number; max: number } {
  let min = schema.minimum ?? DEFAULT_NUMBER_MIN
  let max = schema.maximum ?? DEFAULT_NUMBER_MAX

  if (typeof schema.exclusiveMinimum === 'number') min = schema.exclusiveMinimum + 1
  else if (schema.exclusiveMinimum === true && schema.minimum !== undefined) {
    min = schema.minimum + 1
  }

  if (typeof schema.exclusiveMaximum === 'number') max = schema.exclusiveMaximum - 1
  else if (schema.exclusiveMaximum === true && schema.maximum !== undefined) {
    max = schema.maximum - 1
  }

  if (max < min) max = min
  return { min, max }
}

export function applyMultipleOf(value: number, schema: Schema): number {
  const step = schema.multipleOf
  if (step === undefined || step <= 0) return value
  const { min, max } = numberBounds(schema)
  const snapped = Math.floor(value / step) * step
  if (snapped >= min) return snapped
  const raised = Math.ceil(min / step) * step
  return raised <= max ? raised : snapped
}

function bounded(
  min: number | undefined,
  max: number | undefined,
  fallbackMin: number,
  fallbackMax: number
): { min: number; max: number } {
  const low = min ?? fallbackMin
  const high = max ?? Math.max(fallbackMax, low)
  return { min: low, max: high < low ? low : high }
}

export function stringLength(schema: Schema): { min: number; max: number } {
  return bounded(
    schema.minLength, schema.maxLength, DEFAULT_STRING_MIN, DEFAULT_STRING_MAX
  )
}

export function arrayLength(schema: Schema): { min: number; max: number } {
  return bounded(
    schema.minItems, schema.maxItems, DEFAULT_ARRAY_MIN, DEFAULT_ARRAY_MAX
  )
}
