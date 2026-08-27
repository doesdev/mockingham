import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRng } from '../../src/generate/rng.ts'
import { generateValue } from '../../src/generate/generate.ts'
import type { Schema } from '../../src/spec/types.ts'
import { compileResolvers } from '../../src/resolve/resolvers.ts'

test('generates an object with all required properties', () => {
  const schema: Schema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      tag: { type: 'string' }
    }
  }
  const value = generateValue(schema, createRng('obj')) as Record<string, unknown>
  assert.equal(typeof value.id, 'number')
  assert.equal(typeof value.name, 'string')
})

test('generates arrays within item bounds', () => {
  const schema: Schema = { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 }
  const value = generateValue(schema, createRng('arr')) as unknown[]
  assert.ok(Array.isArray(value))
  assert.ok(value.length >= 2 && value.length <= 4)
  for (const item of value) assert.equal(typeof item, 'string')
})

test('prefers a spec example over generation', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  assert.equal(generateValue(schema, createRng('ex')), 'fixed-value')
})

test('preferExamples false ignores the example', () => {
  const schema: Schema = { type: 'string', example: 'fixed-value' }
  const value = generateValue(schema, createRng('ex'), { preferExamples: false })
  assert.notEqual(value, 'fixed-value')
})

test('honors a length constraint declared inside allOf', () => {
  // Pre-fix, generation read constraints off the un-merged schema and produced a
  // default-length string, so a 40-character minimum was ignored.
  const value = generateValue(
    { allOf: [{ type: 'string', minLength: 40 }] }, createRng('allof'), {}
  ) as string
  assert.equal(typeof value, 'string')
  assert.ok(value.length >= 40, `expected at least 40 characters, got ${value.length}`)
})

test('uses default when no example is present', () => {
  assert.equal(generateValue({ type: 'string', default: 'dflt' }, createRng('d')), 'dflt')
})

test('picks from enum', () => {
  const schema: Schema = { type: 'string', enum: ['a', 'b', 'c'] }
  const value = generateValue(schema, createRng('en'))
  assert.ok(['a', 'b', 'c'].includes(value as string))
})

test('returns const verbatim', () => {
  assert.equal(generateValue({ const: 42 }, createRng('c')), 42)
})

test('picks a variant for a union', () => {
  const schema: Schema = { oneOf: [{ type: 'string' }, { type: 'integer' }] }
  const value = generateValue(schema, createRng('un'))
  assert.ok(typeof value === 'string' || typeof value === 'number')
})

test('terminates on a recursive schema at maxDepth', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  const value = generateValue(node, createRng('rec'), { maxDepth: 2 })
  assert.equal(typeof value, 'object')
})

test('is deterministic for a given seed', () => {
  const schema: Schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: 'integer' } }
  }
  const first = generateValue(schema, createRng('stable'))
  const second = generateValue(schema, createRng('stable'))
  assert.deepEqual(first, second)
})

test('an unknown schema generates null', () => {
  assert.equal(generateValue({}, createRng('unk')), null)
})

test('generation consults byFormat resolvers', () => {
  const value = generateValue(
    { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byFormat: { email: () => 'fixed@example.com' } }) }
  ) as Record<string, unknown>
  assert.equal(value['email'], 'fixed@example.com')
})

test('generation consults bySchema using the schema name table', () => {
  const user = {
    type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } }
  }
  const schemaNames = new Map([[user, 'User']])
  const value = generateValue(user, createRng('resolvers'), {
    schemaNames,
    resolvers: compileResolvers({ bySchema: { User: { id: () => 42 } } })
  }) as Record<string, unknown>
  assert.equal(value['id'], 42)
  assert.equal(typeof value['name'], 'string')
})

test('a resolver beats a spec example', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string', example: 'from-spec' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', () => 'from-resolver']] }) }
  ) as Record<string, unknown>
  assert.equal(value['id'], 'from-resolver')
})

test('a resolver may return a promise, left unsettled for the override pass', () => {
  const value = generateValue(
    { type: 'object', properties: { id: { type: 'string' } } },
    createRng('resolvers'),
    { resolvers: compileResolvers({ byName: [['id', async () => 'later']] }) }
  ) as Record<string, unknown>
  assert.ok(value['id'] instanceof Promise)
})

const variantUnion: Schema = {
  oneOf: [
    { type: 'object', properties: { outcome: { const: 'created' }, id: { type: 'string' } } },
    { type: 'object', properties: { outcome: { const: 'conflict' } } }
  ]
}

test('a requested variant selects its branch', () => {
  // The plan asked for `conflict` under seed `s`, but that is exactly what the
  // seeded pick already returns - the test passed before the feature existed
  // and could not fail. Requesting the OTHER branch is what has teeth, and the
  // baseline assertion below keeps it that way if the PRNG ever changes.
  const seeded = generateValue(variantUnion, createRng('s'), {}) as Record<string, unknown>
  assert.equal(seeded.outcome, 'conflict', 'the seeded pick must differ from the requested variant')

  const value = generateValue(
    variantUnion, createRng('s'), { variant: 'created' }
  ) as Record<string, unknown>
  assert.equal(value.outcome, 'created')
  // Assert the branch, not just the discriminator: a branch chosen by luck
  // would also carry the right outcome half the time.
  assert.equal(typeof value.id, 'string')
})

test('an unmatched variant falls through to the seeded pick', () => {
  const seeded = generateValue(variantUnion, createRng('s'), {})
  const unmatched = generateValue(variantUnion, createRng('s'), { variant: 'nonexistent' })
  assert.deepEqual(unmatched, seeded)
})

test('variant selection is deterministic', () => {
  const first = generateValue(variantUnion, createRng('s'), { variant: 'created' })
  const second = generateValue(variantUnion, createRng('s'), { variant: 'created' })
  assert.deepEqual(first, second)
  // Pin the branch too, or this passes on any two identical values - including
  // the seeded pick that selection was supposed to override.
  assert.equal((first as Record<string, unknown>).outcome, 'created')
})

// Four levels of object nesting - the ordinary shape of a response envelope
// wrapping a payload. The old default of 3 truncated `c` to `{}` while
// answering 200, so the body violated the document's own `required` list.
const deeplyNested: Schema = {
  type: 'object',
  required: ['a'],
  properties: {
    a: {
      type: 'object',
      required: ['b'],
      properties: {
        b: {
          type: 'object',
          required: ['c'],
          properties: {
            c: {
              type: 'object',
              required: ['label'],
              properties: { label: { type: 'string' } }
            }
          }
        }
      }
    }
  }
}

test('the default depth budget generates an ordinary four-level envelope whole', () => {
  const value = generateValue(deeplyNested, createRng('repro')) as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >
  assert.equal(typeof value.a.b.c.label, 'string')
})

test('the default depth budget still terminates on a recursive schema', () => {
  const node: Schema = { type: 'object', required: ['child'], properties: {} }
  node.properties = { child: node }
  const value = generateValue(node, createRng('rec'))
  assert.equal(typeof value, 'object')
})

test('a recursive union terminates rather than looping forever', () => {
  // Resolving a union no longer spends a level, so a union whose only branch
  // is itself has nothing but the union-hop guard to stop it.
  const cycle: Schema = {}
  cycle.oneOf = [cycle]
  assert.doesNotThrow(() => generateValue(cycle, createRng('cycle')))
})

// The same document twice: once with the payload behind a `oneOf`, once with
// that union's first branch inlined. The nesting is identical, so the two must
// truncate in the same place - choosing a branch is a decision about what this
// node is, not a step down the tree.
const unionBranch: Schema = {
  type: 'object',
  required: ['status', 'item'],
  properties: {
    status: { const: 'found' },
    item: {
      type: 'object',
      required: ['sku'],
      properties: { sku: { type: 'string' } }
    }
  }
}

const envelope: Schema = {
  type: 'object',
  required: ['result'],
  properties: {
    result: {
      type: 'object',
      required: ['payload'],
      properties: {
        payload: {
          oneOf: [
            unionBranch,
            {
              type: 'object',
              required: ['status'],
              properties: { status: { const: 'missing' } }
            }
          ]
        }
      }
    }
  }
}

const envelopeControl: Schema = {
  type: 'object',
  required: ['result'],
  properties: {
    result: {
      type: 'object',
      required: ['payload'],
      properties: { payload: unionBranch }
    }
  }
}

test('a union costs no level of the depth budget', () => {
  // maxDepth 3 puts the cutoff exactly where the union sits, which is the
  // configuration the old code lost a whole level in.
  const union = generateValue(envelope, createRng('repro'), {
    maxDepth: 3,
    variant: 'found'
  }) as Record<string, Record<string, Record<string, unknown>>>
  const control = generateValue(envelopeControl, createRng('repro'), {
    maxDepth: 3
  }) as Record<string, Record<string, Record<string, unknown>>>
  // The control keeps `status` and truncates `item`; the union case must do
  // exactly the same rather than losing everything below `payload`.
  assert.equal(control.result.payload.status, 'found')
  assert.deepEqual(control.result.payload.item, {})
  assert.equal(union.result.payload.status, 'found')
  assert.deepEqual(union.result.payload.item, {})
})

test('an exhausted union yields the chosen branch shape, not null', () => {
  const value = generateValue(envelope, createRng('repro'), {
    maxDepth: 2,
    variant: 'found'
  }) as Record<string, Record<string, unknown>>
  // An object is declared here, so an empty object is the honest truncation.
  // `null` is a harder failure for a consumer than an empty object of the
  // right type, and the array and object cases already truncate in kind.
  assert.deepEqual(value.result.payload, {})
})

test('truncating an object reports the schema path it truncated', () => {
  const paths: string[] = []
  generateValue(deeplyNested, createRng('repro'), {
    maxDepth: 2,
    onDepthExhausted: (path) => paths.push(path)
  })
  assert.deepEqual(paths, ['$.a.b'])
})

test('truncating inside an array reports the path with the array step', () => {
  const schema: Schema = {
    type: 'object',
    required: ['rows'],
    properties: {
      rows: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['cell'],
          properties: {
            cell: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } }
          }
        }
      }
    }
  }
  const paths: string[] = []
  generateValue(schema, createRng('repro'), {
    maxDepth: 2,
    onDepthExhausted: (path) => paths.push(path)
  })
  assert.ok(paths.includes('$.rows[]'))
})

test('a schema that fits the budget reports no truncation', () => {
  const paths: string[] = []
  generateValue(deeplyNested, createRng('repro'), {
    onDepthExhausted: (path) => paths.push(path)
  })
  assert.deepEqual(paths, [])
})

test('reporting truncation does not change the generated bytes', () => {
  const quiet = generateValue(deeplyNested, createRng('repro'), { maxDepth: 2 })
  const loud = generateValue(deeplyNested, createRng('repro'), {
    maxDepth: 2,
    onDepthExhausted: () => {}
  })
  assert.deepEqual(loud, quiet)
})
