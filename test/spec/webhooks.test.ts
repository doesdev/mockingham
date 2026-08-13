import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        parameters: [
          { name: 'X-Topic', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'ignored', in: 'query', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/subscriptions': {
      post: {
        operationId: 'subscribe',
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: {
                requestBody: {
                  content: { 'application/json': { schema: { type: 'object' } } }
                },
                responses: { '200': { description: 'ok' } }
              }
            }
          },
          onOrderCanceled: {
            '{$request.body#/cancelUrl}': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['reason'],
                        properties: { reason: { type: 'string' } }
                      }
                    }
                  }
                },
                responses: { '200': { description: 'ok' } }
              }
            }
          }
        }
      }
    },
    '/plain': { get: { operationId: 'plain', responses: { '200': { description: 'ok' } } } }
  }
}

const api = loadApi(doc)
const find = (id: string) => api.operations.find((op) => op.operationId === id)!

test('a top-level webhook is parsed with its method and body schema', () => {
  const hook = api.webhooks['onOrderShipped']!
  assert.equal(hook.name, 'onOrderShipped')
  assert.equal(hook.method, 'post')
  assert.deepEqual(hook.body?.['application/json']?.schema.required, ['orderId'])
})

test('only header parameters are kept on a webhook', () => {
  // The others cannot travel on an outbound request the mock originates.
  const hook = api.webhooks['onOrderShipped']!
  assert.deepEqual(hook.headers.map((p) => p.name), ['X-Topic'])
})

test('callbacks are parsed with the expression preserved as text', () => {
  // The expression can only be resolved against a live request, so it stays
  // text here rather than being compiled at load time.
  const callbacks = find('subscribe').callbacks
  assert.equal(callbacks.length, 2)
  const shipped = callbacks.find((c) => c.name === 'onOrderShipped')!
  assert.equal(shipped.expression, '{$request.body#/callbackUrl}')
  assert.equal(shipped.method, 'post')
})

test('an operation declaring no callbacks gets an empty list, not undefined', () => {
  assert.deepEqual(find('plain').callbacks, [])
})

test('a callback contributes a webhook entry under its own name', () => {
  // So emit() has exactly one place to look for a payload schema.
  const canceled = api.webhooks['onOrderCanceled']!
  assert.equal(canceled.name, 'onOrderCanceled')
  assert.deepEqual(canceled.body?.['application/json']?.schema.required, ['reason'])
})

test('a top-level webhook wins a name collision with a callback', () => {
  // onOrderShipped is declared both ways; the top-level declaration is the
  // document's more explicit one, and its schema requires orderId.
  assert.deepEqual(
    api.webhooks['onOrderShipped']?.body?.['application/json']?.schema.required,
    ['orderId']
  )
})

test('a document declaring neither yields an empty webhook map', () => {
  const bare = loadApi({ openapi: '3.1.0', paths: {} })
  assert.deepEqual(bare.webhooks, {})
})
