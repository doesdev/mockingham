import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRecursive, buildRequest } from '../../src/fixtures/source.ts'
import { createCompiler } from '../../src/schema/compile.ts'
import type { Schema } from '../../src/spec/types.ts'

test('a flat schema is not recursive', () => {
  assert.equal(isRecursive({ type: 'object', properties: { a: { type: 'string' } } }), false)
})

test('a schema with nested but non-cyclic objects is not recursive', () => {
  // Guards against a mutant that returns true whenever `seen` is non-empty on
  // a later call, rather than only when the exact node reappears.
  const leaf: Schema = { type: 'object', properties: { value: { type: 'string' } } }
  const root: Schema = { type: 'object', properties: { a: leaf, b: leaf } }
  assert.equal(isRecursive(root), false)
})

test('a self-referencing schema is recursive', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  assert.equal(isRecursive(node), true)
})

test('a schema recursive through an array is recursive', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { children: { type: 'array', items: node } }
  assert.equal(isRecursive(node), true)
})

test('a cycle expressed through an allOf member is still recursive', () => {
  // classify() -> mergeAllOf() allocates a NEW object on every call for a
  // schema with `allOf`. If the recursion guard tracked that fresh merged
  // object's identity instead of the original schema references, a cycle
  // routed through an allOf member would never repeat an identity and the
  // guard would miss it (and, separately, `mergeAllOf` recursing into an
  // allOf member that is literally itself will stack-overflow regardless —
  // that is a pre-existing hazard in mergeAllOf, not something isRecursive
  // introduces or can guard against). This schema exercises the case
  // isRecursive IS responsible for: the cyclic edge lives on a property
  // absorbed from an allOf member, one level removed from direct
  // self-reference.
  const inner: Schema = { type: 'object', properties: {} }
  const outer: Schema = { allOf: [inner] }
  inner.properties = { child: outer }
  assert.equal(isRecursive(outer), true)
})

function baseOperation() {
  return {
    method: 'get' as const,
    path: '/users/{id}',
    operationId: 'getUser',
    parameters: [],
    responses: [],
    callbacks: []
  }
}

test('a request carries both schema representations', () => {
  const schema: Schema = {
    type: 'object',
    properties: { bio: { type: 'string' }, age: { type: 'integer' } },
    required: ['bio']
  }
  const request = buildRequest({
    operation: baseOperation(),
    status: 200,
    key: 'a3f19c2e',
    params: { id: '42' },
    schema,
    compiler: createCompiler(),
    schemaNames: new Map()
  })
  assert.ok(request)

  // The plain JSON Schema is what makes a non-Anthropic source writable —
  // design section 2.3. Check more than `type` so an implementation that
  // returns `{ type: 'object' }` and drops everything else does not pass.
  const json = request.jsonSchema as {
    type?: string
    properties?: Record<string, { type?: string }>
    required?: string[]
  }
  assert.equal(json.type, 'object')
  assert.equal(json.properties?.['bio']?.type, 'string')
  assert.equal(json.properties?.['age']?.type, 'integer')
  assert.deepEqual(json.required, ['bio'])

  // The zod schema must actually validate — accepting good input and
  // rejecting bad input, not merely being present.
  assert.equal(request.zodSchema.safeParse({ bio: 'hi' }).success, true)
  assert.equal(request.zodSchema.safeParse({ age: 5 }).success, false, 'missing required bio')
  assert.equal(request.zodSchema.safeParse({ bio: 5 }).success, false, 'wrong type for bio')

  assert.equal(request.operationId, 'getUser')
  assert.equal(request.method, 'get')
  assert.equal(request.path, '/users/{id}')
  assert.equal(request.status, 200)
  assert.equal(request.key, 'a3f19c2e')
  assert.deepEqual(request.params, { id: '42' })
})

test('a request carries through summary, description, example, and persona', () => {
  const schema: Schema = { type: 'object', properties: { bio: { type: 'string' } } }
  const request = buildRequest({
    operation: {
      method: 'get',
      path: '/users/{id}',
      operationId: 'getUser',
      summary: 'Get a user',
      description: 'Fetches a single user by id',
      parameters: [],
      responses: [],
      callbacks: []
    },
    status: 200,
    key: 'k',
    params: {},
    schema,
    compiler: createCompiler(),
    schemaNames: new Map(),
    example: { bio: 'sample' },
    persona: 'a terse support agent'
  })
  assert.ok(request)
  assert.equal(request.summary, 'Get a user')
  assert.equal(request.description, 'Fetches a single user by id')
  assert.deepEqual(request.example, { bio: 'sample' })
  assert.equal(request.persona, 'a terse support agent')
})

test('a recursive schema builds no request', () => {
  const node: Schema = { type: 'object', properties: {} }
  node.properties = { child: node }
  const request = buildRequest({
    operation: { method: 'get', path: '/n', operationId: 'n',
      parameters: [], responses: [], callbacks: [] },
    status: 200,
    key: 'k',
    params: {},
    schema: node,
    compiler: createCompiler(),
    schemaNames: new Map()
  })
  assert.equal(request, undefined)
})

test('operationId falls back to method and path when the operation has none', () => {
  const schema: Schema = { type: 'object', properties: {} }
  const request = buildRequest({
    operation: { method: 'post', path: '/widgets/{id}',
      parameters: [], responses: [], callbacks: [] },
    status: 201,
    key: 'k',
    params: { id: '1' },
    schema,
    compiler: createCompiler(),
    schemaNames: new Map()
  })
  assert.ok(request)
  assert.equal(request.operationId, 'post_widgets_id')
})
