import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripUnsupportedKeywords } from '../../../src/fixtures/sources/json-schema-strip.ts'

test('a schema with no constraints passes through unchanged', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' } } }
  assert.deepEqual(stripUnsupportedKeywords(schema), schema)
})

test('stripped keywords do not survive nested inside properties, items, or anyOf', () => {
  const schema = {
    type: 'object',
    properties: {
      bio: { type: 'string', minLength: 1, maxLength: 500 },
      tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } },
      contact: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'object', properties: { count: { type: 'integer', minimum: 0 } } }
        ]
      }
    }
  }
  const stripped = stripUnsupportedKeywords(schema) as {
    properties: {
      bio: Record<string, unknown>
      tags: { items: Record<string, unknown> }
      contact: { anyOf: [Record<string, unknown>, { properties: { count: Record<string, unknown> } }] }
    }
  }
  assert.equal(stripped.properties.bio.minLength, undefined)
  assert.equal(stripped.properties.bio.maxLength, undefined)
  assert.equal(stripped.properties.tags.items.pattern, undefined)
  assert.equal(stripped.properties.contact.anyOf[0].minLength, undefined)
  assert.equal(stripped.properties.contact.anyOf[1].properties.count.minimum, undefined)
})

test('a stripped constraint is folded into the property description', () => {
  const schema = { type: 'string', minLength: 3 }
  const stripped = stripUnsupportedKeywords(schema) as { description: string }
  assert.equal(stripped.description, 'Minimum length: 3.')
})

test('multiple stripped constraints on one node compose in sorted-keyword order, deterministically', () => {
  const schema = { type: 'integer', maximum: 100, minimum: 0 }
  const stripped = stripUnsupportedKeywords(schema) as { description: string }
  // 'maximum' sorts before 'minimum'.
  assert.equal(stripped.description, 'Maximum value: 100. Minimum value: 0.')
  // Running it again produces byte-identical output - required for the
  // request to be byte-identical across processes (prompt caching, bake
  // reproducibility).
  const again = stripUnsupportedKeywords(schema) as { description: string }
  assert.equal(again.description, stripped.description)
})

test('an existing description is preserved, with the stripped note appended after it', () => {
  const schema = { type: 'string', description: 'The user bio.', minLength: 1 }
  const stripped = stripUnsupportedKeywords(schema) as { description: string }
  assert.equal(stripped.description, 'The user bio. Minimum length: 1.')
})

test('describeStripped: false discards the constraint instead of folding it into description', () => {
  const schema = { type: 'string', minLength: 1 }
  const stripped = stripUnsupportedKeywords(schema, { describeStripped: false }) as Record<string, unknown>
  assert.equal(stripped.minLength, undefined)
  assert.equal(stripped.description, undefined)
})

test('extraKeywords strips additional keywords beyond the shared set (format, for OpenAI)', () => {
  const schema = { type: 'string', format: 'email' }
  const withoutExtra = stripUnsupportedKeywords(schema) as Record<string, unknown>
  assert.equal(withoutExtra.format, 'email')
  const withExtra = stripUnsupportedKeywords(schema, { extraKeywords: ['format'] }) as Record<string, unknown>
  assert.equal(withExtra.format, undefined)
  assert.equal(withExtra.description, 'Format: email.')
})

test('the input is never mutated, at any nesting depth', () => {
  const schema = {
    type: 'object',
    properties: { address: { type: 'object', properties: { city: { type: 'string', minLength: 1 } } } }
  }
  const before = JSON.stringify(schema)
  stripUnsupportedKeywords(schema)
  assert.equal(JSON.stringify(schema), before)
  const city = (schema as { properties: { address: { properties: { city: Record<string, unknown> } } } })
    .properties.address.properties.city
  assert.deepEqual(city, { type: 'string', minLength: 1 })
})

test('format is not stripped by default - Anthropic documents it as a supported keyword', () => {
  const schema = { type: 'string', format: 'uuid' }
  const stripped = stripUnsupportedKeywords(schema) as Record<string, unknown>
  assert.equal(stripped.format, 'uuid')
})

// --- Structural awareness: `properties` is a MAP, its KEYS are user-chosen
// property names, never schema keywords. Before this, the generic walk
// treated every object (including a `properties` map) as a schema node and
// deleted any property literally NAMED after a stripped keyword.

test('a schema whose PROPERTY NAMES collide with stripped keywords keeps every one of them', () => {
  const schema = {
    type: 'object',
    properties: {
      format: { type: 'string' },
      pattern: { type: 'string' },
      minimum: { type: 'number' },
      name: { type: 'string' }
    },
    required: ['format', 'pattern', 'minimum', 'name']
  }
  const stripped = stripUnsupportedKeywords(schema) as {
    properties: Record<string, unknown>
    required: string[]
    description?: string
  }
  assert.deepEqual(Object.keys(stripped.properties).sort(), ['format', 'minimum', 'name', 'pattern'])
  // No phantom description injected on the object node from mistaking these
  // property NAMES for stripped keywords.
  assert.equal(stripped.description, undefined)
  // required still names properties that actually exist.
  assert.deepEqual(stripped.required.sort(), ['format', 'minimum', 'name', 'pattern'])
})

test('a real constraint nested under a property named after a keyword is still stripped', () => {
  // `minimum` is both a property NAME here and, on ITS OWN value, carries a
  // real `minimum` KEYWORD - proving the fix does not overcorrect into never
  // stripping anything under such a property.
  const schema = {
    type: 'object',
    properties: {
      minimum: { type: 'number', minimum: 0 }
    }
  }
  const stripped = stripUnsupportedKeywords(schema) as {
    properties: { minimum: { minimum?: number; description?: string } }
  }
  assert.equal(stripped.properties.minimum.minimum, undefined)
  assert.equal(stripped.properties.minimum.description, 'Minimum value: 0.')
})

test('patternProperties and $defs are walked as schema maps too: their keys survive even when named after a stripped keyword', () => {
  const schema = {
    type: 'object',
    patternProperties: {
      '^pattern$': { type: 'string', minLength: 1 }
    },
    $defs: {
      minimum: { type: 'object', properties: { x: { type: 'string' } } }
    }
  }
  const stripped = stripUnsupportedKeywords(schema) as {
    patternProperties: Record<string, { minLength?: number; description?: string }>
    $defs: Record<string, unknown>
  }
  assert.ok('^pattern$' in stripped.patternProperties)
  assert.equal(stripped.patternProperties['^pattern$']?.minLength, undefined)
  assert.equal(stripped.patternProperties['^pattern$']?.description, 'Minimum length: 1.')
  assert.ok('minimum' in stripped.$defs)
})

test('additionalProperties as a schema is walked; as a boolean it passes through unchanged', () => {
  const schemaObject = { type: 'object', additionalProperties: { type: 'string', minLength: 2 } }
  const strippedObject = stripUnsupportedKeywords(schemaObject) as {
    additionalProperties: { minLength?: number; description?: string }
  }
  assert.equal(strippedObject.additionalProperties.minLength, undefined)
  assert.equal(strippedObject.additionalProperties.description, 'Minimum length: 2.')

  const schemaBool = { type: 'object', additionalProperties: false }
  const strippedBool = stripUnsupportedKeywords(schemaBool) as { additionalProperties: boolean }
  assert.equal(strippedBool.additionalProperties, false)
})

test('prefixItems is walked as a list of schemas, same as allOf/anyOf/oneOf', () => {
  const schema = {
    type: 'array',
    prefixItems: [{ type: 'string', minLength: 1 }, { type: 'number', minimum: 0 }]
  }
  const stripped = stripUnsupportedKeywords(schema) as {
    prefixItems: Array<{ minLength?: number; minimum?: number }>
  }
  assert.equal(stripped.prefixItems[0]?.minLength, undefined)
  assert.equal(stripped.prefixItems[1]?.minimum, undefined)
})

test('data-only keys - const, default, examples, enum - are copied through untouched, never walked as schemas', () => {
  // A `default`/`const`/`examples` value can itself contain an object whose
  // keys happen to collide with stripped keywords or schema-map keywords -
  // it must never be mistaken for a nested schema.
  const schema = {
    type: 'object',
    default: { minimum: 5, properties: 'not a schema map' },
    const: { pattern: 'literal data, not a keyword' },
    examples: [{ format: 'literal data too' }],
    enum: ['minimum', 'pattern']
  }
  const stripped = stripUnsupportedKeywords(schema) as Record<string, unknown>
  assert.deepEqual(stripped.default, { minimum: 5, properties: 'not a schema map' })
  assert.deepEqual(stripped.const, { pattern: 'literal data, not a keyword' })
  assert.deepEqual(stripped.examples, [{ format: 'literal data too' }])
  assert.deepEqual(stripped.enum, ['minimum', 'pattern'])
})
