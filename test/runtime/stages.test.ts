import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createAuthStage } from '../../src/runtime/auth.ts'
import { createValidationStage } from '../../src/runtime/validate.ts'
import { createFailureStage } from '../../src/runtime/failure.ts'
import { compilePolicies } from '../../src/runtime/failure.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { buildCtx, recordingFail } from '../helpers/ctx.ts'

const api = loadApi({
  openapi: '3.1.0',
  paths: {
    '/pets/{id}': {
      get: {
        operationId: 'getPet',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } }
        ],
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
})

const operation = api.operations[0]!

test('every stage factory returns a named function', () => {
  // The stated benefit of a factory over an anonymous closure: a stack trace
  // names the stage that responded. An anonymous arrow reports "".
  const { fail } = recordingFail()
  assert.equal(
    createAuthStage({ security: operation.security, schemes: api.securitySchemes, config: {}, fail }).name,
    'authStage'
  )
  assert.equal(createValidationStage({ operation, fail }).name, 'validationStage')
  assert.equal(
    createFailureStage({
      operation, policies: [], store: createMemoryStore(), chaosSeed: 's',
      requestKey: 'k', counter: () => 1, sleep: async () => {}, fail
    }).name,
    'failureStage'
  )
})

test('authStage denies a request with no credential', async () => {
  const { fail, calls } = recordingFail()
  const stage = createAuthStage({
    security: operation.security, schemes: api.securitySchemes, config: {}, fail
  })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 401)
  assert.deepEqual(calls, [{ status: 401, code: 'MOCK_UNAUTHORIZED' }])
})

test('authStage continues and sets ctx.auth when credentialed', async () => {
  // checkAuth only produces a principal when a scheme's verify() runs — a
  // presence-only check (config: {}) legitimately yields `principal:
  // undefined` (see test/runtime/auth.test.ts's presence-only-check test).
  // A verify() is supplied here so this test actually exercises the "sets
  // ctx.auth" half of its name, without changing checkAuth's behavior.
  const { fail } = recordingFail()
  const stage = createAuthStage({
    security: operation.security,
    schemes: api.securitySchemes,
    config: { bearer: { verify: () => ({ sub: 'u1' }) } },
    fail
  })
  const ctx = buildCtx({
    request: new Request('http://mock/pets/1', { headers: { authorization: 'Bearer t' } }),
    operation,
    params: { id: '1' }
  })

  assert.equal(await stage(ctx), undefined)
  assert.ok(ctx.auth)
})

test('validationStage reports the failing path', async () => {
  const { fail, calls } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/abc'), operation, params: { id: 'abc' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 400)
  assert.deepEqual(calls, [{ status: 400, code: 'MOCK_REQUEST_INVALID' }])
})

test('validationStage continues on a valid request', async () => {
  const { fail } = recordingFail()
  const stage = createValidationStage({ operation, fail })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  assert.equal(await stage(ctx), undefined)
})

test('failureStage answers when decide() returns a directive', async () => {
  const { fail, calls } = recordingFail()
  const stage = createFailureStage({
    operation,
    policies: compilePolicies([], api.operations),
    decide: () => ({ status: 502, code: 'MOCK_DOWN' }),
    store: createMemoryStore(),
    chaosSeed: 'chaos',
    requestKey: 'k',
    counter: () => 1,
    sleep: async () => {},
    fail
  })
  const ctx = buildCtx({ request: new Request('http://mock/pets/1'), operation, params: { id: '1' } })

  const response = await stage(ctx)

  assert.equal(response?.status, 502)
  assert.deepEqual(calls, [{ status: 502, code: 'MOCK_DOWN' }])
})
