import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFor, toolNamed } from './helpers.ts'

test('describe_operation returns params, bodies, responses, and security', async () => {
  const result = (await toolNamed('describe_operation').handler(
    contextFor(), { operationId: 'createOrder' }
  )) as {
    method: string
    path: string
    parameters: Array<{ name: string; location: string; required: boolean }>
    requestBody?: { required: boolean; content: Record<string, unknown> }
    responses: Array<{ status: number; schema?: Record<string, unknown> }>
    security: unknown
  }

  assert.equal(result.method, 'POST')
  assert.equal(result.path, '/orders')
  assert.equal(result.requestBody?.required, true)
  assert.deepEqual(result.responses.map((entry) => entry.status), [201, 400])

  const created = result.responses.find((entry) => entry.status === 201)
  assert.equal(created?.schema?.type, 'object')
  assert.deepEqual(created?.schema?.required, ['id', 'total'])
})

test('describe_operation addresses an operation by method and path too', async () => {
  const result = (await toolNamed('describe_operation').handler(
    contextFor(), { method: 'get', path: '/orders/{orderId}' }
  )) as { operationId?: string }

  assert.equal(result.operationId, 'getOrder')
})

test('describe_operation reports an unknown operation as an error', async () => {
  await assert.rejects(
    async () => toolNamed('describe_operation').handler(contextFor(), { operationId: 'nope' }),
    /nope/
  )
})

test('get_auth_requirements narrows to one operation when asked', async () => {
  const scoped = (await toolNamed('get_auth_requirements').handler(
    contextFor(), { operationId: 'createOrder' }
  )) as { requirements: unknown; schemes: Record<string, unknown> }

  assert.deepEqual(scoped.requirements, [{ apiKeyAuth: [] }])
  assert.ok(scoped.schemes.apiKeyAuth, 'the named scheme must be described')
})

test('get_auth_requirements reports an operation that opted out of auth', async () => {
  const scoped = (await toolNamed('get_auth_requirements').handler(
    contextFor(), { operationId: 'health' }
  )) as { requirements: unknown[] }

  // `security: []` in the document means "no auth", which must not be
  // confused with "inherits the document default".
  assert.deepEqual(scoped.requirements, [])
})

test('get_auth_requirements describes the whole document when unscoped', async () => {
  const all = (await toolNamed('get_auth_requirements').handler(contextFor(), {})) as {
    schemes: Record<string, unknown>
  }

  assert.deepEqual(Object.keys(all.schemes).sort(), ['apiKeyAuth', 'bearerAuth'])
})
