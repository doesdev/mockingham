import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDocument } from '../../src/spec/refs.ts'

test('inlines a simple internal ref', () => {
  const doc = {
    components: { schemas: { User: { type: 'object' } } },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const out = resolveDocument(doc).document as any
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
  const out = resolveDocument(doc).document as any
  const node = out.components.schemas.Node
  const inner = node.properties.children.items
  assert.equal(inner.type, 'object')
  assert.strictEqual(inner, node)
  assert.strictEqual(inner.properties.children.items, node)
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
  const out = resolveDocument(doc).document as any
  const b = out.components.schemas.B
  assert.equal(b.type, 'object')
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

test('decodes JSON pointer escapes', () => {
  const doc = {
    components: { schemas: { 'a/b': { type: 'string' } } },
    x: { $ref: '#/components/schemas/a~1b' }
  }
  const out = resolveDocument(doc).document as any
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

test('names every component schema by identity', () => {
  const doc = {
    components: {
      schemas: {
        User: { type: 'object', properties: { id: { type: 'integer' } } },
        Pet: { type: 'object' }
      }
    },
    paths: { '/u': { get: { schema: { $ref: '#/components/schemas/User' } } } }
  }
  const { document, schemaNames } = resolveDocument(doc)
  const user = (document as any).paths['/u'].get.schema
  assert.equal(schemaNames.get(user), 'User')
  assert.equal(schemaNames.get((document as any).components.schemas.Pet), 'Pet')
})

test('an alias records the first declared name', () => {
  const doc = {
    components: {
      schemas: {
        A: { type: 'object' },
        B: { $ref: '#/components/schemas/A' }
      }
    }
  }
  const { document, schemaNames } = resolveDocument(doc)
  // A and B resolve to the same object; the first declared name wins so the
  // table is stable no matter what order later code reads it in.
  assert.strictEqual((document as any).components.schemas.A, (document as any).components.schemas.B)
  assert.equal(schemaNames.get((document as any).components.schemas.A), 'A')
})

test('schemas outside components are absent from the table', () => {
  const doc = { paths: { '/u': { get: { schema: { type: 'string' } } } } }
  const { document, schemaNames } = resolveDocument(doc)
  assert.equal(schemaNames.get((document as any).paths['/u'].get.schema), undefined)
})
