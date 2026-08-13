import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { toJsonSchema } from '../../src/schema/json-schema.ts'

test('converts a schema to JSON Schema', () => {
  const json = toJsonSchema(
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    createCompiler()
  )

  assert.equal(json?.type, 'object')
  assert.deepEqual(json?.required, ['id'])
})

test('converts a self-referential schema without throwing', () => {
  const node: Record<string, unknown> = { type: 'object', properties: {} }
  ;(node.properties as Record<string, unknown>).child = node

  const json = toJsonSchema(node as never, createCompiler())

  assert.ok(json, 'a recursive schema must convert, not vanish')
})
