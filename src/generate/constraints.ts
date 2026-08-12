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

  // A numeric exclusive bound (3.1) and a plain bound may both be present, and
  // both must hold — so take whichever is tighter rather than letting the last
  // branch win. The boolean form (3.0) only modifies its own plain bound.
  if (typeof schema.exclusiveMinimum === 'number') {
    min = Math.max(min, schema.exclusiveMinimum + 1)
  } else if (schema.exclusiveMinimum === true && schema.minimum !== undefined) {
    min = schema.minimum + 1
  }

  if (typeof schema.exclusiveMaximum === 'number') {
    max = Math.min(max, schema.exclusiveMaximum - 1)
  } else if (schema.exclusiveMaximum === true && schema.maximum !== undefined) {
    max = schema.maximum - 1
  }

  // As with `bounded`, an explicit bound is never violated. When the two
  // sides conflict, only the side that came from a default yields — a lone
  // explicit maximum below the default minimum of 0 must win, not be
  // silently overwritten back up to 0.
  const hasExplicitMin =
    schema.minimum !== undefined || typeof schema.exclusiveMinimum === 'number'
  const hasExplicitMax =
    schema.maximum !== undefined || typeof schema.exclusiveMaximum === 'number'
  if (max < min) {
    if (hasExplicitMax && !hasExplicitMin) min = max
    else max = min
  }
  return { min, max }
}

export function applyMultipleOf(value: number, schema: Schema): number {
  const step = schema.multipleOf
  if (step === undefined || step <= 0) return value
  const { min, max } = numberBounds(schema)
  const snapped = Math.floor(value / step) * step
  if (snapped >= min && snapped <= max) return snapped
  const raised = Math.ceil(min / step) * step
  if (raised <= max) return raised
  // No multiple of `step` exists anywhere in [min, max]. Staying inside the
  // declared range matters more than the multiple, so the bounds win.
  return min
}

/**
 * Resolves an optional min/max pair against defaults, guaranteeing `max >= min`.
 *
 * An explicitly declared bound is never violated. When only one is given, the
 * default on the other side yields to it — including when a lone `max` sits
 * below the default minimum, which is the case that silently corrupted output
 * before: `maxLength: 2` must not resolve to a minimum of 5.
 */
function bounded(
  min: number | undefined,
  max: number | undefined,
  fallbackMin: number,
  fallbackMax: number
): { min: number; max: number } {
  if (min !== undefined && max !== undefined) {
    return { min, max: max < min ? min : max }
  }
  if (min !== undefined) return { min, max: Math.max(fallbackMax, min) }
  if (max !== undefined) return { min: Math.min(fallbackMin, max), max }
  return { min: fallbackMin, max: fallbackMax }
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
