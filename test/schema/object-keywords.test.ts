import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { classify } from '../../src/schema/walk.ts'
import { generateValue } from '../../src/generate/generate.ts'
import { createRng } from '../../src/generate/rng.ts'
import type { GenerateOptions } from '../../src/generate/generate.ts'
import type { Schema } from '../../src/spec/types.ts'

const SEEDS = Array.from({ length: 24 }, (_, index) => `seed-${index}`)

function generate(
  schema: Schema,
  seed: string,
  options: GenerateOptions = {}
): Record<string, unknown> {
  return generateValue(schema, createRng(seed), {
    maxDepth: 12,
    ...options
  }) as Record<string, unknown>
}

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

/**
 * Every seed generates a body the SAME schema's compiled form accepts. This is
 * invariant 1 stated as a test: what we generate is what we validate.
 */
function roundTrips(schema: Schema): void {
  const compiled = createCompiler().compile(schema)
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    const result = compiled.safeParse(value)
    assert.ok(
      result.success,
      `seed ${seed} generated ${JSON.stringify(value)}: ${
        result.success ? '' : result.error.issues.map((i) => i.message).join('; ')
      }`
    )
  }
}

// ---------------------------------------------------------------- classify

test('classify carries all four object keywords onto the object kind', () => {
  const schema: Schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    propertyNames: { pattern: '^[a-z]+$' },
    patternProperties: { '^x_[a-z]{3}$': { type: 'string' } },
    dependentRequired: { a: ['b'] },
    dependentSchemas: { a: { required: ['c'] } }
  }
  const kind = classify(schema)
  assert.equal(kind.kind, 'object')
  if (kind.kind !== 'object') return
  // A property NAME is always a string, so `classify` supplies the type the
  // document left implicit - the one place that reading is made.
  assert.deepEqual(kind.propertyNames, {
    pattern: '^[a-z]+$',
    type: 'string'
  })
  assert.deepEqual(kind.patternProperties, {
    '^x_[a-z]{3}$': { type: 'string' }
  })
  assert.deepEqual(kind.dependentRequired, { a: ['b'] })
  assert.deepEqual(kind.dependentSchemas, { a: { required: ['c'] } })
})

test('a schema declaring only patternProperties is an object, not unknown', () => {
  const kind = classify({ patternProperties: { '^x_': { type: 'string' } } })
  assert.equal(kind.kind, 'object')
})

test('a schema declaring only dependentRequired is an object, not unknown', () => {
  const kind = classify({ dependentRequired: { a: ['b'] } })
  assert.equal(kind.kind, 'object')
})

test('mergeAllOf accumulates patternProperties and dependentRequired across members', () => {
  const kind = classify({
    allOf: [
      { type: 'object', patternProperties: { '^a_': { type: 'string' } },
        dependentRequired: { x: ['y'] } },
      { patternProperties: { '^b_': { type: 'number' } },
        dependentRequired: { x: ['z'] } }
    ]
  })
  assert.equal(kind.kind, 'object')
  if (kind.kind !== 'object') return
  assert.deepEqual(Object.keys(kind.patternProperties), ['^a_', '^b_'])
  assert.deepEqual(kind.dependentRequired['x'], ['y', 'z'])
})

// ------------------------------------------------------------ propertyNames

test('propertyNames rejects a key whose name violates it', () => {
  const schema: Schema = {
    type: 'object',
    propertyNames: { pattern: '^[a-z]+$' }
  }
  assert.equal(parse(schema, { abc: 1 }).success, true)
  assert.equal(parse(schema, { Abc: 1 }).success, false)
})

test('propertyNames honors maxLength on the name', () => {
  const schema: Schema = { type: 'object', propertyNames: { maxLength: 4 } }
  assert.equal(parse(schema, { abcd: 1 }).success, true)
  assert.equal(parse(schema, { abcde: 1 }).success, false)
})

test('propertyNames: false forbids every key', () => {
  const schema: Schema = { type: 'object', propertyNames: false }
  assert.equal(parse(schema, {}).success, true)
  assert.equal(parse(schema, { a: 1 }).success, false)
})

test('generation omits an OPTIONAL declared property whose name propertyNames forbids', () => {
  const schema: Schema = {
    type: 'object',
    required: ['keep'],
    properties: {
      keep: { type: 'string' },
      TOOLOUD: { type: 'string' }
    },
    propertyNames: { pattern: '^[a-z]+$' }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.ok(Object.hasOwn(value, 'keep'))
    assert.equal(Object.hasOwn(value, 'TOOLOUD'), false)
  }
  roundTrips(schema)
})

test('a REQUIRED property whose name propertyNames forbids is still emitted - the sacrifice is named', () => {
  const schema: Schema = {
    type: 'object',
    required: ['TOOLOUD'],
    properties: { TOOLOUD: { type: 'string' } },
    propertyNames: { pattern: '^[a-z]+$' }
  }
  const value = generate(schema, 'seed-0')
  assert.ok(Object.hasOwn(value, 'TOOLOUD'))
})

// -------------------------------------------------------- patternProperties

test('patternProperties constrains a key matching its regex', () => {
  const schema: Schema = {
    type: 'object',
    patternProperties: { '^x_': { type: 'string' } }
  }
  assert.equal(parse(schema, { x_a: 'v' }).success, true)
  assert.equal(parse(schema, { x_a: 1 }).success, false)
  // A key matching no pattern is unconstrained when additionalProperties is absent.
  assert.equal(parse(schema, { other: 1 }).success, true)
})

test('a member matching a pattern is NOT additional, so additionalProperties: false still admits it', () => {
  const schema: Schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    additionalProperties: false,
    patternProperties: { '^x_': { type: 'string' } }
  }
  assert.equal(parse(schema, { id: 'a', x_b: 'v' }).success, true)
  // ...but a key matching neither properties nor a pattern is rejected.
  assert.equal(parse(schema, { id: 'a', nope: 'v' }).success, false)
  // ...and a matching key still has to satisfy the pattern's schema.
  assert.equal(parse(schema, { id: 'a', x_b: 9 }).success, false)
})

test('patternProperties composes with properties: a declared key matching a pattern must satisfy both', () => {
  const schema: Schema = {
    type: 'object',
    properties: { x_count: { type: 'string' } },
    patternProperties: { '^x_': { type: 'string', minLength: 3 } }
  }
  assert.equal(parse(schema, { x_count: 'abcd' }).success, true)
  assert.equal(parse(schema, { x_count: 'ab' }).success, false)
})

test('generation invents a member for a pattern no declared property covers', () => {
  const schema: Schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    additionalProperties: false,
    patternProperties: { '^x_[a-z]{3}$': { type: 'string', minLength: 2 } }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    const invented = Object.keys(value).filter((key) => /^x_[a-z]{3}$/.test(key))
    assert.equal(invented.length, 1, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(typeof value[invented[0] as string], 'string')
  }
  roundTrips(schema)
})

test('generation does not invent a member when a declared property already matches the pattern', () => {
  const schema: Schema = {
    type: 'object',
    properties: { x_abc: { type: 'string' } },
    patternProperties: { '^x_[a-z]{3}$': { type: 'string' } }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.deepEqual(Object.keys(value), ['x_abc'])
  }
})

test('an invented member name is deterministic for a seed and independent of process', () => {
  const schema: Schema = {
    type: 'object',
    patternProperties: {
      '^a_[a-z]{4}$': { type: 'string' },
      '^b_[a-z]{4}$': { type: 'integer' }
    }
  }
  const first = generate(schema, 'fixed')
  const second = generate(schema, 'fixed')
  assert.deepEqual(first, second)
  // Object.entries order of the pattern map is the ONLY ordering: the a_ member
  // is emitted before the b_ member, every time.
  const keys = Object.keys(first)
  assert.equal(keys.length, 2)
  assert.ok((keys[0] as string).startsWith('a_'))
  assert.ok((keys[1] as string).startsWith('b_'))
})

test('a pattern outside the generatable subset warns and invents nothing', () => {
  const seen: string[] = []
  const schema: Schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    patternProperties: { '^(?=.*x)[a-z]+$': { type: 'string' } }
  }
  const value = generate(schema, 'seed-0', {
    onUnsupportedPattern: (pattern) => seen.push(pattern)
  })
  assert.deepEqual(seen, ['^(?=.*x)[a-z]+$'])
  assert.deepEqual(Object.keys(value), ['id'])
})

// ------------------------------------------------------- dependentRequired

test('dependentRequired rejects a body carrying the trigger without its dependents', () => {
  const schema: Schema = {
    type: 'object',
    properties: { card: { type: 'string' } },
    dependentRequired: { card: ['billingAddress'] }
  }
  assert.equal(parse(schema, {}).success, true)
  assert.equal(parse(schema, { card: 'x' }).success, false)
  assert.equal(
    parse(schema, { card: 'x', billingAddress: 'somewhere' }).success,
    true
  )
})

/**
 * The anti-coincidence case. Generation emits every DECLARED property, so a
 * dependency naming a declared property is satisfied by accident and proves
 * nothing. `billingAddress` is deliberately NOT under `properties`, so the only
 * way it can appear is if `dependentRequired` is actually read.
 */
test('generation emits a dependent that is NOT declared under properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['card'],
    properties: { card: { type: 'string' } },
    additionalProperties: { type: 'string' },
    dependentRequired: { card: ['billingAddress'] }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.ok(Object.hasOwn(value, 'card'), `seed ${seed}`)
    assert.ok(
      Object.hasOwn(value, 'billingAddress'),
      `seed ${seed}: ${JSON.stringify(value)}`
    )
    assert.equal(typeof value['billingAddress'], 'string')
  }
  roundTrips(schema)
})

test('an undeclared dependent with nothing said about it is still PRESENT', () => {
  const schema: Schema = {
    type: 'object',
    properties: { card: { type: 'string' } },
    dependentRequired: { card: ['token'] }
  }
  const value = generate(schema, 'seed-0')
  assert.ok(Object.hasOwn(value, 'token'))
  roundTrips(schema)
})

test('an undeclared dependent takes its shape from a matching patternProperties entry', () => {
  const schema: Schema = {
    type: 'object',
    properties: { card: { type: 'string' } },
    patternProperties: { '^billing[A-Z][a-z]+$': { type: 'integer' } },
    dependentRequired: { card: ['billingCode'] }
  }
  const value = generate(schema, 'seed-0')
  assert.equal(Number.isInteger(value['billingCode']), true)
})

/**
 * The seam the parallel `not`/union work widened: an object recognized by a
 * bare `required` with no `type` and no `properties`.
 */
test('dependentRequired is read on a schema that is an object by bare required alone', () => {
  const schema: Schema = {
    required: ['card'],
    dependentRequired: { card: ['billingAddress'] }
  }
  assert.equal(classify(schema).kind, 'object')
  assert.equal(parse(schema, { card: 'x' }).success, false)
  assert.equal(parse(schema, { card: 'x', billingAddress: 1 }).success, true)
})

/** The other seam: a conditional branch that declares the dependency. */
test('dependentRequired declared on a `then` branch is honored in both directions', () => {
  const schema: Schema = {
    type: 'object',
    required: ['state'],
    properties: { state: { type: 'string', enum: ['open', 'canceled'] } },
    if: { properties: { state: { const: 'canceled' } }, required: ['state'] },
    then: { dependentRequired: { state: ['reason'] } }
  }
  assert.equal(parse(schema, { state: 'open' }).success, true)
  assert.equal(parse(schema, { state: 'canceled' }).success, false)
  assert.equal(parse(schema, { state: 'canceled', reason: 'x' }).success, true)
  roundTrips(schema)
})

test('an optional trigger is DROPPED when its dependent cannot be emitted at all', () => {
  const schema: Schema = {
    type: 'object',
    properties: { card: { type: 'string' } },
    additionalProperties: false,
    dependentRequired: { card: ['billingAddress'] }
  }
  const value = generate(schema, 'seed-0')
  assert.deepEqual(value, {})
  roundTrips(schema)
})

// -------------------------------------------------------- dependentSchemas

test('dependentSchemas applies the whole schema once the trigger is present', () => {
  const schema: Schema = {
    type: 'object',
    properties: { card: { type: 'string' } },
    dependentSchemas: {
      card: { required: ['cvv'], properties: { cvv: { type: 'integer' } } }
    }
  }
  assert.equal(parse(schema, {}).success, true)
  assert.equal(parse(schema, { card: 'x' }).success, false)
  assert.equal(parse(schema, { card: 'x', cvv: 'no' }).success, false)
  assert.equal(parse(schema, { card: 'x', cvv: 3 }).success, true)
})

test('generation satisfies a triggered dependentSchemas branch', () => {
  const schema: Schema = {
    type: 'object',
    required: ['card'],
    properties: { card: { type: 'string' } },
    dependentSchemas: {
      card: { required: ['cvv'], properties: { cvv: { type: 'integer' } } }
    }
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    assert.ok(Object.hasOwn(value, 'cvv'), `seed ${seed}`)
    assert.equal(Number.isInteger(value['cvv']), true)
  }
  roundTrips(schema)
})

// ------------------------------------------------------------- seam guards
//
// Added AFTER the implementation, against the three code paths other work is
// changing concurrently - the union sibling base, the conditional branches,
// and the object branch widened to read a bare `required`. They are guards:
// they assert the behavior proven above keeps holding once those changes land
// beside this one.

test('seam: patternProperties survives through a union sibling base', () => {
  const schema: Schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    patternProperties: { '^m_[a-z]{3}$': { type: 'integer' } },
    anyOf: [{ required: ['id'] }, { required: ['other'] }]
  }
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    const invented = Object.keys(value).filter((key) => /^m_[a-z]{3}$/.test(key))
    assert.equal(invented.length, 1, `seed ${seed}: ${JSON.stringify(value)}`)
    assert.equal(Number.isInteger(value[invented[0] as string]), true)
  }
})

test('seam: patternProperties declared on an `else` branch is applied there', () => {
  const schema: Schema = {
    type: 'object',
    required: ['state'],
    properties: { state: { type: 'string', enum: ['open', 'canceled'] } },
    if: { properties: { state: { const: 'canceled' } }, required: ['state'] },
    then: {},
    else: { patternProperties: { '^open_[a-z]{2}$': { type: 'string' } } }
  }
  let sawElse = false
  for (const seed of SEEDS) {
    const value = generate(schema, seed)
    const invented = Object.keys(value).filter((key) => /^open_[a-z]{2}$/.test(key))
    if (value['state'] === 'canceled') {
      assert.equal(invented.length, 0, `seed ${seed}: ${JSON.stringify(value)}`)
      continue
    }
    sawElse = true
    assert.equal(invented.length, 1, `seed ${seed}: ${JSON.stringify(value)}`)
  }
  assert.ok(sawElse, 'no seed took the else branch - the guard would be vacuous')
  roundTrips(schema)
})

test('seam: a member matching a pattern is generated even under additionalProperties: false on a bare-required object', () => {
  const schema: Schema = {
    required: ['id'],
    properties: { id: { type: 'string' } },
    additionalProperties: false,
    patternProperties: { '^m_[a-z]{3}$': { type: 'integer' } }
  }
  assert.equal(classify(schema).kind, 'object')
  roundTrips(schema)
})

test('an untriggered dependentSchemas contributes nothing', () => {
  const schema: Schema = {
    type: 'object',
    properties: { other: { type: 'string' } },
    dependentSchemas: {
      card: { required: ['cvv'], properties: { cvv: { type: 'integer' } } }
    }
  }
  const value = generate(schema, 'seed-0')
  assert.deepEqual(Object.keys(value), ['other'])
})
