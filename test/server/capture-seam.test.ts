import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import type { Store } from '../../src/runtime/store.ts'

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

test('a BARE document callbacks expression resolves, it does not become the URL', async () => {
  // OpenAPI writes callbacks keys bare, and this is the site the whole
  // normalization exists for — yet it was the one compile site still passing a
  // caller-written expression to resolveExpression un-normalized. A bare key
  // matched no token, resolved to ITSELF, and the literal text
  // "$request.body#/hook" was stored as the destination and used as the
  // delivery URL. With a real fetch that is an outbound request to a string.
  // `isSupported` cannot catch it: a string with no tokens is vacuously
  // supported, so no startup warning fired either.
  const bareDoc = structuredClone(doc) as unknown as {
    paths: Record<string, Record<string, { callbacks: Record<string, unknown> }>>
  }
  bareDoc.paths['/orders']!.post!.callbacks = {
    orderDone: {
      '$request.body#/hook': { post: { responses: { 200: { description: 'ok' } } } }
    }
  }

  const warnings: string[] = []
  const mock = createMock(bareDoc as unknown as Record<string, unknown>, {
    captureOnly: true,
    onWarn: (message) => warnings.push(message)
  })
  await mock.fetch(
    new Request('http://mock/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook: 'https://consumer.example/bare' })
    })
  )
  const delivery = await mock.emit('orderDone')
  assert.equal(delivery.url, 'https://consumer.example/bare')
  assert.equal(delivery.outcome, 'captured')
  assert.deepEqual(warnings, [])
})

test('a callbacks expression reading the RESPONSE body still captures', async () => {
  // The body gate at the single exit, asked of the callback kind. A callbacks
  // expression pointing at `$response.body` needs the exit to have captured
  // that body; leave the callback kind out of the gate and `captured` is null,
  // the expression resolves against an undefined result body, and the
  // destination is silently never stored. Every other callbacks test in the
  // suite reads the REQUEST body, which is present either way.
  const responseDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          responses: {
            201: {
              description: 'made',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { hook: { type: 'string', format: 'uri' } },
                    required: ['hook']
                  }
                }
              }
            }
          },
          callbacks: {
            orderDone: {
              '{$response.body#/hook}': { post: { responses: { 200: { description: 'ok' } } } }
            }
          }
        }
      }
    }
  }
  const mock = createMock(responseDoc, { captureOnly: true, seed: 'response-callback' })
  const created = (await (await mock.fetch(
    new Request('http://mock/orders', { method: 'POST' })
  )).json()) as { hook: string }

  const delivery = await mock.emit('orderDone')
  assert.equal(delivery.url, created.hook)
})

/**
 * Invariant 6 at the capture site: a throw inside the capture pass reaches
 * `onError` and never the caller. The pass is the newest thing running at the
 * single exit, and it writes to a Store the embedder supplies — so a Store that
 * rejects is the realistic failure, not a hypothetical one.
 */
const captureDoc = {
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
        responses: {
          201: {
            description: 'made',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id']
                }
              }
            }
          }
        },
        callbacks: {
          orderDone: {
            '{$request.body#/hook}': { post: { responses: { 200: { description: 'ok' } } } }
          }
        }
      }
    },
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
} as Record<string, unknown>

function refusingStore(): { store: Store; refused: string[] } {
  const inner = createMemoryStore(() => 0)
  const refused: string[] = []
  const store: Store = {
    ...inner,
    async set(key, value, ttlMs) {
      // Only the three key namespaces the capture pass writes. Refusing every
      // write would take down idempotency and the delivery log too, and the
      // throw under test would no longer be attributable to the capture pass.
      if (/^(link|registration|callback)\|/.test(key)) {
        refused.push(key)
        throw new Error(`store refused ${key}`)
      }
      await inner.set(key, value, ttlMs)
    }
  }
  return { store, refused }
}

test('a Store that refuses a capture write reaches onError, never the caller', async () => {
  const { store, refused } = refusingStore()
  const errors: unknown[] = []
  const mock = createMock(captureDoc, {
    store,
    seed: 'capture-throw',
    captureOnly: true,
    link: [
      {
        from: { target: 'createOrder', key: '{$response.body#/id}' },
        to: { target: 'getOrder', key: '{$request.path.id}' }
      }
    ],
    onError: (error: unknown) => errors.push(error)
  })

  const control = createMock(captureDoc, { seed: 'capture-throw', captureOnly: true })

  const send = (m: typeof mock) =>
    m.fetch(new Request('http://mock/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook: 'https://consumer.example/done' })
    }))

  const response = await send(mock)
  const expected = await send(control)

  // The caller gets the ORIGINAL response — same status and same bytes as the
  // mock that never touched a refusing store — not a 500 and not a truncated
  // body.
  assert.equal(response.status, 201)
  assert.equal(await response.text(), await expected.text())

  // The refusal really happened — otherwise the two halves above would agree
  // for the uninteresting reason that nothing was ever written.
  assert.deepEqual(refused, ['callback|orderDone'])
  // A throw aborts the rest of the pass, which is precisely why it has to be
  // reported: the `link` rule behind it never ran and nothing else in the
  // system would notice.
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as Error).message), /store refused callback\|orderDone/)
})
