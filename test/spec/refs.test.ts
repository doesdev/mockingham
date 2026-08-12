import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDocument } from '../../src/spec/refs.ts'

test('inlines a simple internal ref', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const out = resolveDocument(doc) as any
  assert.equal(out.paths['/u'].get.schema.type, 'object')
})

test('resolves a self-recursive schema without infinite recursion', () => {
  const doc = {
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }
          }
        }
      }
    }
  }
  const out = resolveDocument(doc) as any
  const node = out.components.schemas.Node
  const inner = node.properties.children.items
  assert.equal(inner.type, 'object')
  // the cycle is a real object cycle, not a copy
  assert.strictEqual(inner, node)
  assert.strictEqual(inner.properties.children.items, node)
})

test('decodes JSON pointer escapes', () => {
  const doc = {
    components: { schemas: { 'a/b': { type: 'string' } } },
    x: { $ref: '#/components/schemas/a~1b' }
  }
  const out = resolveDocument(doc) as any
  assert.equal(out.x.type, 'string')
})

test('throws on an external ref', () => {
  const doc = { x: { $ref: 'other.json#/Thing' } }
  assert.throws(() => resolveDocument(doc), /only internal \$ref/)
})

test('throws on an unresolvable ref, naming the pointer', () => {
  const doc = { x: { $ref: '#/components/schemas/Missing' } }
  assert.throws(() => resolveDocument(doc), /#\/components\/schemas\/Missing/)
})

test('does not mutate the input document', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    x: { $ref: '#/components/schemas/User' }
  }
  resolveDocument(doc)
  assert.deepEqual((doc as any).x, { $ref: '#/components/schemas/User' })
})

test('resolves a recursive schema reached through an alias', () => {
  const doc = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: {
          type: 'object',
          properties: { self: { $ref: '#/components/schemas/A' } }
        }
      }
    }
  }
  const out = resolveDocument(doc) as any
  const b = out.components.schemas.B
  assert.equal(b.type, 'object')
  // A is an alias for B, so B.self must be B itself
  assert.strictEqual(b.properties.self, b)
  assert.strictEqual(out.components.schemas.A, b)
})

test('throws on a reference chain that never reaches a schema', () => {
  const doc = {
    components: {
      schemas: {
        A: { $ref: '#/components/schemas/B' },
        B: { $ref: '#/components/schemas/A' }
      }
    }
  }
  assert.throws(() => resolveDocument(doc), /circular \$ref chain/)
})
