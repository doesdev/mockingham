import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

test('extracts every operation', () => {
  const api = loadApi(petstore)
  assert.equal(api.version, '3.1.0')
  const ids = api.operations.map((op) => op.operationId).sort()
  assert.deepEqual(ids, ['createPet', 'listPets', 'myPet', 'showPetById'])
})

test('merges path-level parameters into each operation', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.ok(op)
  const petId = op.parameters.find((p) => p.name === 'petId')
  assert.ok(petId)
  assert.equal(petId.location, 'path')
  assert.equal(petId.required, true)
})

test('resolves refs inside response schemas', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  const schema = op?.responses[0]?.content['application/json']?.schema
  assert.equal(schema?.type, 'object')
  assert.equal(schema?.properties?.name?.type, 'string')
})

test('parses response status codes as numbers, in ascending order', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.deepEqual(op?.responses.map((r) => r.status), [200, 404])
})

test('throws when the document has no openapi version', () => {
  assert.throws(() => loadApi({ paths: {} }), /openapi/)
})

test('an operation-level parameter replaces the path-level one', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.ok(op)
  const matching = op.parameters.filter(
    (p) => p.name === 'petId' && p.location === 'path'
  )
  assert.equal(matching.length, 1, 'the override must replace, not append')
  assert.equal(matching[0]?.schema.minimum, 1, 'the operation-level schema wins')
})

test('throws when paths is present but malformed', () => {
  assert.throws(
    () => loadApi({ openapi: '3.1.0', paths: null }),
    /"paths" must be an object/
  )
  assert.throws(
    () => loadApi({ openapi: '3.1.0', paths: [] }),
    /"paths" must be an object/
  )
})

test('an absent paths is legal and yields no operations', () => {
  const api = loadApi({ openapi: '3.1.0' })
  assert.deepEqual(api.operations, [])
})

test('captures a default response separately from numeric ones', () => {
  const api = loadApi({
    openapi: '3.1.0',
    paths: {
      '/thing': {
        get: {
          operationId: 'getThing',
          responses: {
            '200': { description: 'ok' },
            default: { description: 'error' }
          }
        }
      }
    }
  })
  const op = api.operations[0]
  assert.deepEqual(op?.responses.map((r) => r.status), [200])
  assert.equal(op?.defaultResponse?.description, 'error')
})

test('exposes component schema names on the api', () => {
  const api = loadApi(petstore)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  const schema = op?.responses[0]?.content['application/json']?.schema
  assert.ok(schema)
  assert.equal(api.schemaNames.get(schema), 'Pet')
})

const secured = {
  openapi: '3.1.0',
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'showPetById',
        security: [{ bearerAuth: ['pets:read'] }],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    }
  }
}

test('loads security schemes', () => {
  const api = loadApi(secured)
  assert.equal(api.securitySchemes['bearerAuth']?.type, 'http')
  assert.equal(api.securitySchemes['bearerAuth']?.scheme, 'bearer')
  assert.equal(api.securitySchemes['apiKey']?.location, 'header')
  assert.equal(api.securitySchemes['apiKey']?.name, 'x-api-key')
})

test('loads per-operation security requirements', () => {
  const api = loadApi(secured)
  const op = api.operations.find((o) => o.operationId === 'showPetById')
  assert.deepEqual(op?.security, [{ bearerAuth: ['pets:read'] }])
})

test('a document with no security schemes yields an empty record', () => {
  assert.deepEqual(loadApi(petstore).securitySchemes, {})
})

test('an operation without security inherits the document default', () => {
  const doc = {
    openapi: '3.1.0',
    security: [{ apiKey: [] }],
    paths: { '/a': { get: { operationId: 'a', responses: { '200': {} } } } }
  }
  const api = loadApi(doc)
  assert.deepEqual(api.operations[0]?.security, [{ apiKey: [] }])
})

test('an explicit empty security array means no auth and is not overwritten', () => {
  // `security: []` is meaningfully different from an absent security field:
  // it opts the operation out of a document-level default.
  const doc = {
    openapi: '3.1.0',
    security: [{ apiKey: [] }],
    paths: {
      '/a': { get: { operationId: 'a', security: [], responses: { '200': {} } } }
    }
  }
  assert.deepEqual(loadApi(doc).operations[0]?.security, [])
})

test('an absent security field stays undefined when the document declares none', () => {
  const doc = {
    openapi: '3.1.0',
    paths: { '/a': { get: { operationId: 'a', responses: { '200': {} } } } }
  }
  assert.equal(loadApi(doc).operations[0]?.security, undefined)
})

test('records whether a request body is required', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/a': {
        post: {
          operationId: 'a',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  }
  assert.equal(loadApi(doc).operations[0]?.requestBodyRequired, true)
})

test('an absent required flag is falsy', () => {
  const doc = {
    openapi: '3.1.0',
    paths: {
      '/a': {
        post: {
          operationId: 'a',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  }
  assert.notEqual(loadApi(doc).operations[0]?.requestBodyRequired, true)
})

test('loads operation tags, defaulting to an empty array', () => {
  const api = loadApi({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: { operationId: 'a', tags: ['pets', 'admin'], responses: {} } },
      '/b': { get: { operationId: 'b', responses: {} } }
    }
  })

  const a = api.operations.find((op) => op.operationId === 'a')
  const b = api.operations.find((op) => op.operationId === 'b')
  assert.deepEqual(a?.tags, ['pets', 'admin'])
  assert.deepEqual(b?.tags, [])
})

test('drops non-string tags rather than coercing them', () => {
  const api = loadApi({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: { operationId: 'a', tags: ['ok', 7, null, { x: 1 }], responses: {} } }
    }
  })

  assert.deepEqual(api.operations[0]?.tags, ['ok'])
})
