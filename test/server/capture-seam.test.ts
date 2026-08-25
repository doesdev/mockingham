import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { hook: { type: 'string' } } }
            }
          }
        },
        responses: { 201: { description: 'made' } },
        callbacks: {
          orderDone: {
            '{$request.body#/hook}': { post: { responses: { 200: { description: 'ok' } } } }
          }
        }
      }
    }
  }
}

test('a document callbacks destination still resolves through the capture pass', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await mock.fetch(
    new Request('http://mock/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook: 'https://consumer.example/done' })
    })
  )
  const delivery = await mock.emit('orderDone')
  // The exact URL, not merely "resolved": a tier that silently fell through to
  // a configured or empty destination would still produce a Delivery.
  assert.equal(delivery.url, 'https://consumer.example/done')
  assert.equal(delivery.outcome, 'captured')
})
