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

test('describe_operation distinguishes a range response from an exact status', async () => {
  // Both carry status 400 - a range's `status` is its bucket's lower bound -
  // so without the flag an agent sees two entries reporting the same status
  // with different schemas and no way to tell which is which.
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/thing': {
        get: {
          operationId: 'thing',
          responses: {
            '400': {
              description: 'exact',
              content: {
                'application/json': { schema: { type: 'object', properties: { exact: { type: 'string' } } } }
              }
            },
            '4XX': {
              description: 'range',
              content: {
                'application/json': { schema: { type: 'object', properties: { ranged: { type: 'string' } } } }
              }
            }
          }
        }
      }
    }
  }

  const result = (await toolNamed('describe_operation').handler(
    contextFor(doc), { operationId: 'thing' }
  )) as { responses: Array<{ status: number; range?: boolean; description?: string }> }

  assert.deepEqual(result.responses.map((entry) => entry.status), [400, 400])
  assert.deepEqual(result.responses.map((entry) => entry.range), [undefined, true])
  // Paired with the description so the two are unambiguous end to end.
  assert.deepEqual(
    result.responses.map((entry) => entry.description),
    ['exact', 'range']
  )
})

test('describe_operation addresses an operation by method and path too', async () => {
  const result = (await toolNamed('describe_operation').handler(
    contextFor(), { method: 'get', path: '/orders/{orderId}' }
  )) as { operationId?: string }

  assert.equal(result.operationId, 'getOrder')
})

test('a mismatched operationId and method/path pair is refused', async () => {
  // Deferred item 29a: the operationId branch used to return on its own match
  // without checking a co-supplied method/path, so a caller who named two
  // different operations was silently answered about one of them.
  await assert.rejects(
    async () =>
      toolNamed('describe_operation').handler(contextFor(), {
        operationId: 'createOrder',
        method: 'get',
        path: '/orders/{orderId}'
      }),
    /disagree/
  )
})

test('an operationId with an agreeing method and path still resolves', async () => {
  // The check must reject disagreement, not the mere presence of extra fields.
  const result = (await toolNamed('describe_operation').handler(contextFor(), {
    operationId: 'createOrder',
    method: 'post',
    path: '/orders'
  })) as { operationId?: string }

  assert.equal(result.operationId, 'createOrder')
})

test('the agreement check reaches sample_response and get_auth_requirements too', async () => {
  // All three resolve through the same helper; a fix in one that missed the
  // others would be the asymmetry the ledger complains about elsewhere.
  for (const name of ['sample_response', 'get_auth_requirements']) {
    await assert.rejects(
      async () =>
        toolNamed(name).handler(contextFor(), {
          operationId: 'createOrder',
          method: 'get',
          path: '/orders/{orderId}'
        }),
      /disagree/,
      `${name} must refuse a mismatched pair`
    )
  }
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
