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
  // Running it again produces byte-identical output — required for the
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

test('format is not stripped by default — Anthropic documents it as a supported keyword', () => {
  const schema = { type: 'string', format: 'uuid' }
  const stripped = stripUnsupportedKeywords(schema) as Record<string, unknown>
  assert.equal(stripped.format, 'uuid')
})
