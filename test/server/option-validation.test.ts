import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createHandler } from '../../src/server/handler.ts'

/**
 * Construction-time checks on the options a caller writes by hand.
 *
 * Two shapes, deliberately kept apart. A name that resolves to nothing is a
 * TYPO and throws, matching `resolveTarget`, `emitWebhook` and
 * `assertValidOverrideKeys`. A runtime expression outside the documented subset
 * only WARNS, because the document's own `callbacks` expressions have always
 * warned rather than thrown and a warning-only path must stay warning-only.
 */
const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  webhooks: {
    orderStatusChanged: {
      post: { responses: { '200': { description: 'ok' } } }
    }
  },
  paths: {
    '/subscriptions/{name}': {
      put: {
        operationId: 'setOrderSubscription',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { url: { type: 'string' } } }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      },
      delete: {
        operationId: 'deleteOrderSubscription',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'gone' } }
      }
    },
    '/orders': {
      post: {
        operationId: 'createOrder',
        responses: {
          '201': {
            description: 'made',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } }
              }
            }
          }
        }
      }
    },
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } }
      }
    }
  }
}

const api = loadApi(doc)

function warningsFor(options: Record<string, unknown>): string[] {
  const warnings: string[] = []
  createHandler(api, { ...options, onWarn: (message: string) => warnings.push(message) })
  return warnings
}

// ---------------------------------------------------------------------------
// M2 — a configured webhook name the document never declares.

test('a webhooks option naming an undeclared webhook throws at construction', () => {
  // The gap this closes: such a config builds capture rules that write a
  // registration `registrations()` LISTS, that no emission can resolve —
  // `emitWebhook` throws on the undeclared name — and that `unregister`
  // refuses to remove, because the imperative path asserts what the config
  // path did not.
  assert.throws(
    () =>
      createHandler(api, {
        webhooks: {
          orderStatusChangd: {
            registerVia: { operationId: 'setOrderSubscription', url: '{$request.body#/url}' }
          }
        }
      }),
    /orderStatusChangd/
  )
})

test('a declared webhook name is accepted and its rule is armed', async () => {
  const handler = createHandler(api, {
    captureOnly: true,
    webhooks: {
      orderStatusChanged: {
        registerVia: { operationId: 'setOrderSubscription', url: '{$request.body#/url}' }
      }
    }
  })
  await handler.fetch(
    new Request('http://mock/subscriptions/order-events', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://consumer.example/h' })
    })
  )
  assert.deepEqual(await handler.registrations(), [
    { webhook: 'orderStatusChanged', url: 'https://consumer.example/h', scope: '' }
  ])
})

// ---------------------------------------------------------------------------
// M1 — an expression outside the supported subset warns, on every field that
// takes one.

test('an unsupported registerVia url warns at construction', () => {
  const warnings = warningsFor({
    webhooks: {
      orderStatusChanged: {
        registerVia: { operationId: 'setOrderSubscription', url: '{$request.cookie.url}' }
      }
    }
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /registerVia/)
  assert.match(warnings[0]!, /orderStatusChanged/)
  assert.match(warnings[0]!, /\$request\.cookie\.url/)
})

test('an unsupported scopeBy warns at construction', () => {
  const warnings = warningsFor({
    webhooks: {
      orderStatusChanged: {
        scopeBy: '{$response.path.tenant}',
        registerVia: { operationId: 'setOrderSubscription', url: '{$request.body#/url}' }
      }
    }
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /scopeBy/)
  assert.match(warnings[0]!, /\$response\.path\.tenant/)
})

test('an unsupported link expression warns for each field that carries one', () => {
  const warnings = warningsFor({
    link: [
      {
        from: { target: 'createOrder', key: '{$response.cookie.id}' },
        to: { target: 'getOrder', key: '{$request.cookie.id}' },
        remember: '{$nonsense}'
      }
    ]
  })
  // Three separate fields, three separate warnings: a caller who fixed only
  // the one the mock happened to name first would be back where they started.
  assert.equal(warnings.length, 3)
  assert.match(warnings[0]!, /from\.key/)
  assert.match(warnings[1]!, /to\.key/)
  assert.match(warnings[2]!, /remember/)
  for (const warning of warnings) assert.match(warning, /link rule 0/)
})

test('an unsupported idempotency operation key warns at construction', () => {
  const warnings = warningsFor({
    idempotency: { operations: { createOrder: { key: '{$request.cookie.rid}' } } }
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /idempotency/)
  assert.match(warnings[0]!, /createOrder/)
  assert.match(warnings[0]!, /\$request\.cookie\.rid/)
})

test('supported expressions on every new field warn about nothing', () => {
  const warnings = warningsFor({
    webhooks: {
      orderStatusChanged: {
        scopeBy: '{$request.header.x-tenant-id}',
        registerVia: { operationId: 'setOrderSubscription', url: '$request.body#/url' },
        unregisterVia: { operationId: 'deleteOrderSubscription' }
      }
    },
    link: [
      {
        from: { target: 'createOrder', key: '$response.body#/id' },
        to: { target: 'getOrder', key: '$request.path.id' },
        remember: '$response.body'
      }
    ],
    idempotency: { operations: { createOrder: { key: '$request.body#/rid' } } }
  })
  // The bare spellings above matter as much as the braced ones: normalization
  // runs before the check, so a bare expression must not warn.
  assert.deepEqual(warnings, [])
})
