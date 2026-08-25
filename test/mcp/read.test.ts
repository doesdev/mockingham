import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import type { MockOptions } from '../../src/index.ts'
import { contextForMock, toolNamed } from './helpers.ts'
import { mcpDoc } from './doc.ts'

/**
 * Refinements design §9 and deferred item 29.
 *
 * The fixtures here are deliberately over-specified relative to what any one
 * assertion reads: item 29(b) cannot fail unless a callback-declaring operation
 * and a DIFFERENT configured emitter both exist, and the registry/link
 * assertions cannot distinguish "reported correctly" from "reported for
 * everything" unless some operations lack the capability entirely.
 */

/**
 * A document with a subscription control plane (`registerVia`/`unregisterVia`
 * live on operations that are neither the linking pair nor the callback
 * declarer), a create/read pair to link, and a callback on `POST /orders`.
 */
const capabilityDoc = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { callbackUrl: { type: 'string' } }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' }, total: { type: 'number' } }
                }
              }
            }
          }
        },
        callbacks: {
          orderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '204': { description: 'ack' } } }
            }
          }
        }
      }
    },
    '/orders/{orderId}': {
      get: {
        operationId: 'getOrder',
        parameters: [
          { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'One order',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' }, total: { type: 'number' } }
                }
              }
            }
          }
        }
      }
    },
    '/events': {
      post: {
        operationId: 'deliverEvent',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  meta: { type: 'object', properties: { requestId: { type: 'string' } } }
                }
              }
            }
          }
        },
        responses: { '202': { description: 'accepted' } }
      }
    },
    '/subscriptions/{name}': {
      put: {
        operationId: 'subscribe',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { url: { type: 'string' } } }
            }
          }
        },
        responses: { '200': { description: 'subscribed' } }
      },
      delete: {
        operationId: 'unsubscribe',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { '204': { description: 'gone' } }
      }
    }
  },
  webhooks: {
    orderCreated: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' } }
              }
            }
          }
        },
        responses: { '204': { description: 'ack' } }
      }
    }
  }
}

const capabilityOptions: MockOptions = {
  captureOnly: true,
  link: [
    {
      from: { target: 'createOrder', key: '{$response.body#/id}' },
      to: { target: 'getOrder', key: '{$request.path.orderId}' }
    }
  ],
  idempotency: {
    operations: { deliverEvent: { key: '{$request.body#/meta/requestId}' } }
  },
  webhooks: {
    orderCreated: {
      registerVia: { operationId: 'subscribe', url: '$request.body#/url' },
      unregisterVia: { operationId: 'unsubscribe' }
    }
  }
}

function capabilityContext() {
  const mock = createMock(capabilityDoc, capabilityOptions)
  return { mock, ctx: contextForMock(mock, capabilityOptions) }
}

interface Described {
  operationId?: string
  linksFrom: number[]
  linksTo: number[]
  registersWebhook: string[]
  unregistersWebhook: string[]
  idempotencyKey?: { source: string; value: string }
}

async function describe(operationId: string): Promise<Described> {
  const { ctx } = capabilityContext()
  return (await toolNamed('describe_operation').handler(ctx, { operationId })) as Described
}

// --- design §9: describe_operation carries the capability fields ------------

test('describe_operation reports the link rules an operation records for and recalls from', async () => {
  const created = await describe('createOrder')
  const read = await describe('getOrder')

  // Disjoint on purpose: the recorder is not the recaller, so a field wired to
  // "any operation in any rule" would report [0] on both and be caught here.
  assert.deepEqual(created.linksFrom, [0])
  assert.deepEqual(created.linksTo, [])
  assert.deepEqual(read.linksFrom, [])
  assert.deepEqual(read.linksTo, [0])

  const uninvolved = await describe('deliverEvent')
  assert.deepEqual(uninvolved.linksFrom, [])
  assert.deepEqual(uninvolved.linksTo, [])
})

test('describe_operation reports which webhook an operation registers and unregisters', async () => {
  const subscribe = await describe('subscribe')
  const unsubscribe = await describe('unsubscribe')

  // Again disjoint: registerVia and unregisterVia sit on DIFFERENT operations,
  // so a field that reported both lists for both operations would fail.
  assert.deepEqual(subscribe.registersWebhook, ['orderCreated'])
  assert.deepEqual(subscribe.unregistersWebhook, [])
  assert.deepEqual(unsubscribe.registersWebhook, [])
  assert.deepEqual(unsubscribe.unregistersWebhook, ['orderCreated'])

  const uninvolved = await describe('createOrder')
  assert.deepEqual(uninvolved.registersWebhook, [])
  assert.deepEqual(uninvolved.unregistersWebhook, [])
})

test('describe_operation reports a configured idempotency key as its body pointer', async () => {
  const event = await describe('deliverEvent')
  assert.deepEqual(event.idempotencyKey, {
    source: 'expression',
    value: '{$request.body#/meta/requestId}'
  })

  // An operation with no key at all reports absence, not an empty string: an
  // agent reading `{ source: 'header', value: '' }` would build a broken
  // request instead of knowing this operation is simply not idempotent.
  const order = await describe('createOrder')
  assert.equal(order.idempotencyKey, undefined)
})

test('describe_operation reports a header idempotency key as the header name', async () => {
  const options: MockOptions = { idempotency: { methods: ['POST'], header: 'X-Request-Id' } }
  const mock = createMock(capabilityDoc, options)
  const ctx = contextForMock(mock, options)

  const post = (await toolNamed('describe_operation').handler(
    ctx, { operationId: 'createOrder' }
  )) as Described
  assert.deepEqual(post.idempotencyKey, { source: 'header', value: 'X-Request-Id' })

  // A GET is not in `methods`, so it must report nothing — otherwise the field
  // is just echoing the configured header for every operation.
  const get = (await toolNamed('describe_operation').handler(
    ctx, { operationId: 'getOrder' }
  )) as Described
  assert.equal(get.idempotencyKey, undefined)
})

// --- design §9: list_webhooks gains `registry` but NOT the URLs --------------

interface WebhookEntry {
  name: string
  kind: string
  emittedBy: string[]
  payloadSchema?: Record<string, unknown>
  registry: { configured: boolean; registrations: number }
}

async function webhooks(ctx = capabilityContext().ctx): Promise<WebhookEntry[]> {
  return (await toolNamed('list_webhooks').handler(ctx, {})) as WebhookEntry[]
}

test('list_webhooks reports whether a registry is configured and how many registrations exist', async () => {
  const { mock, ctx } = capabilityContext()
  await mock.register('orderCreated', 'https://a.example/h', 'tenant-1')
  await mock.register('orderCreated', 'https://b.example/h', 'tenant-2')

  const created = (await webhooks(ctx)).find((entry) => entry.name === 'orderCreated')
  assert.deepEqual(created?.registry, { configured: true, registrations: 2 })
})

test('list_webhooks reports a webhook with no registry configuration as unconfigured', async () => {
  // mcpDoc declares `orderCreated` with no registerVia at all. Without this
  // fixture, `configured: true` could be hard-coded and every assertion above
  // would still pass.
  const mock = createMock(mcpDoc, {})
  const created = (await webhooks(contextForMock(mock, {})))
    .find((entry) => entry.name === 'orderCreated')
  assert.deepEqual(created?.registry, { configured: false, registrations: 0 })
})

test('list_webhooks does not disclose registered URLs', async () => {
  const { mock, ctx } = capabilityContext()
  await mock.register('orderCreated', 'https://secret-consumer.example/hook', 'tenant-1')

  // Design §9: a registered destination is a consumer's endpoint and must not
  // appear in a capability listing an agent may dump into a log. Asserted over
  // the whole serialized payload rather than over a named field, because the
  // risk is a URL leaking through some field nobody thought to check.
  const serialized = JSON.stringify(await webhooks(ctx))
  assert.equal(serialized.includes('secret-consumer.example'), false)
})

// --- design §9: the new list_registrations tool DOES return URLs -------------

interface RegistrationEntry {
  webhook: string
  url: string
  scope: string
}

test('list_registrations returns registered URLs, sorted by webhook then scope', async () => {
  const { mock, ctx } = capabilityContext()
  // Inserted out of order: invariant 2 forbids an unordered iteration deciding
  // anything observable, and this listing is observable.
  await mock.register('orderCreated', 'https://z.example/h', 'tenant-z')
  await mock.register('orderCreated', 'https://a.example/h', 'tenant-a')

  const result = (await toolNamed('list_registrations').handler(ctx, {})) as RegistrationEntry[]
  assert.deepEqual(result, [
    { webhook: 'orderCreated', url: 'https://a.example/h', scope: 'tenant-a' },
    { webhook: 'orderCreated', url: 'https://z.example/h', scope: 'tenant-z' }
  ])
})

test('list_registrations filters by webhook name', async () => {
  const { mock, ctx } = capabilityContext()
  await mock.register('orderCreated', 'https://a.example/h', 'tenant-a')
  await mock.register('orderShipped', 'https://b.example/h', 'tenant-b')

  const filtered = (await toolNamed('list_registrations').handler(
    ctx, { webhook: 'orderShipped' }
  )) as RegistrationEntry[]
  assert.deepEqual(filtered, [
    { webhook: 'orderShipped', url: 'https://b.example/h', scope: 'tenant-b' }
  ])
})

test('list_registrations returns an empty array when nothing is registered', async () => {
  const { ctx } = capabilityContext()
  assert.deepEqual(await toolNamed('list_registrations').handler(ctx, {}), [])
})

// --- deferred item 29(a) ----------------------------------------------------

test('findOperation raises when a supplied method and path contradict the operationId', async () => {
  const { ctx } = capabilityContext()
  // A valid operationId AND a valid-but-different method/path pair. Before the
  // fix the operationId branch returned immediately and the mismatch was
  // silently ignored, so the caller got createOrder while believing it had
  // asked for getOrder.
  await assert.rejects(
    async () => toolNamed('describe_operation').handler(ctx, {
      operationId: 'createOrder',
      method: 'GET',
      path: '/orders/{orderId}'
    }),
    /operationId "createOrder" is POST \/orders, but method and path say GET \/orders\/\{orderId\}/
  )
})

test('findOperation accepts a method and path that agree with the operationId', async () => {
  const { ctx } = capabilityContext()
  const result = (await toolNamed('describe_operation').handler(ctx, {
    operationId: 'createOrder',
    method: 'post',
    path: '/orders'
  })) as { operationId?: string; method: string }
  // Named output, not "does not throw": the agreeing pair must still resolve to
  // the operation rather than to some other one.
  assert.equal(result.operationId, 'createOrder')
  assert.equal(result.method, 'POST')
})

test('findOperation raises on a partial contradiction of method alone', async () => {
  const { ctx } = capabilityContext()
  await assert.rejects(
    async () => toolNamed('describe_operation').handler(ctx, {
      operationId: 'createOrder',
      method: 'DELETE'
    }),
    /operationId "createOrder" is POST \/orders, but method and path say DELETE \/orders/
  )
})

// --- deferred item 29(b) ----------------------------------------------------

test('list_webhooks keeps a callback declaring operation in emittedBy alongside a configured emitter', async () => {
  // BOTH halves are required for this test to be able to fail: `POST /orders`
  // declares the `orderShipped` callback, and `POST /events` — a DIFFERENT
  // operation — is configured to emit it. Before the fix, the presence of the
  // configured emitter dropped the declaring operation entirely.
  const options: MockOptions = {
    captureOnly: true,
    operations: { deliverEvent: { emits: [{ webhook: 'orderShipped' }] } },
    webhooks: { orderShipped: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(capabilityDoc, options)
  const entry = (await webhooks(contextForMock(mock, options)))
    .find((candidate) => candidate.name === 'orderShipped')

  // Declarer first, then configured emitters in document order - the ordering
  // settled when this cycle merged with the regenerate/ledger branches, and
  // pinned identically in search-webhooks.test.ts.
  assert.deepEqual(entry?.emittedBy, ['POST /orders', 'POST /events'])
})

test('list_webhooks does not duplicate an operation that both declares and is configured to emit', async () => {
  const options: MockOptions = {
    captureOnly: true,
    operations: { createOrder: { emits: [{ webhook: 'orderShipped' }] } },
    webhooks: { orderShipped: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(capabilityDoc, options)
  const entry = (await webhooks(contextForMock(mock, options)))
    .find((candidate) => candidate.name === 'orderShipped')

  assert.deepEqual(entry?.emittedBy, ['POST /orders'])
})

// --- deferred item 29(c) ----------------------------------------------------

const recursiveWebhookDoc = {
  openapi: '3.1.0',
  info: { title: 'Tree', version: '1.0.0' },
  paths: {
    '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } }
  },
  webhooks: {
    treeChanged: {
      post: {
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Node' } }
          }
        },
        responses: { '204': { description: 'ack' } }
      }
    }
  },
  components: {
    schemas: {
      Node: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }
        }
      }
    }
  }
}

/**
 * Item 29(c) as recorded expects a recursive payload to come back as the
 * `$comment` placeholder. It does not, and cannot: `src/schema/json-schema.ts`
 * says so in its own docstring — "Recursion is NOT such a case — zod emits
 * {"$ref":"#"} and this returns it" — and the assertion below is the evidence.
 * The residual is nonetheless real: `listWebhooks` was the one caller that
 * bypassed `jsonSchemaOf`, so the two tools could report different things for
 * the same schema. That divergence is what these tests pin.
 */
test('list_webhooks reports the same converted schema describe_operation would', async () => {
  const mock = createMock(recursiveWebhookDoc, {})
  const ctx = contextForMock(mock, {})
  const entry = (await webhooks(ctx)).find((candidate) => candidate.name === 'treeChanged')

  // Recursion converts, and it converts to the self-reference — not to
  // `undefined`, which an agent reads as "this webhook carries no payload".
  assert.deepEqual(entry?.payloadSchema?.properties, {
    name: { type: 'string' },
    children: { type: 'array', items: { $ref: '#' } }
  })
})

test('a webhook with no JSON payload reports no schema rather than a placeholder', async () => {
  // The other half of the pair: `undefined` still means "there is no JSON
  // payload here", which is a different statement from "the payload exists and
  // could not be converted". Without this, payloadSchema could be populated
  // unconditionally and the assertion above would still pass.
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } }
    },
    webhooks: { bare: { post: { responses: { '204': { description: 'ack' } } } } }
  }
  const mock = createMock(doc, {})
  const entry = (await webhooks(contextForMock(mock, {})))
    .find((candidate) => candidate.name === 'bare')
  assert.equal(entry?.payloadSchema, undefined)
})

test('a non-recursive webhook payload schema is still converted', async () => {
  const { ctx } = capabilityContext()
  const entry = (await webhooks(ctx)).find((candidate) => candidate.name === 'orderCreated')
  assert.deepEqual(entry?.payloadSchema?.required, ['id'])
})

// --- deferred item L6: a union response advertises its branch names ---------

/**
 * An agent choosing a `set_variant` name had to infer it from raw JSON Schema
 * `const`s buried in a `oneOf`. `describe_operation` names them instead, using
 * `variantName` — the same module `Prefer: variant=` selection reads, so the
 * names an agent is shown are the names the mock answers to.
 */
const variantDoc = {
  openapi: '3.1.0',
  info: { title: 'Payments', version: '1.0.0' },
  paths: {
    '/payments': {
      post: {
        operationId: 'createPayment',
        responses: {
          '200': {
            description: 'Settled, held, or something the schema does not name',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        outcome: { const: 'settled' },
                        id: { type: 'string' }
                      }
                    },
                    {
                      type: 'object',
                      properties: {
                        outcome: { const: 'held' },
                        reason: { type: 'string' }
                      }
                    },
                    // No const-valued property: unnameable, and so unreachable
                    // by `set_variant`. It must not appear in the list.
                    { type: 'object', properties: { id: { type: 'string' } } }
                  ]
                }
              }
            }
          },
          '404': {
            description: 'Not found',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { message: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
}

interface DescribedResponse {
  status: number
  variants?: string[]
}

async function describedResponses(
  doc: Record<string, unknown>,
  operationId: string
): Promise<DescribedResponse[]> {
  const mock = createMock(doc, {})
  const described = (await toolNamed('describe_operation').handler(
    contextForMock(mock, {}), { operationId }
  )) as { responses: DescribedResponse[] }
  return described.responses
}

test('describe_operation names the variants of a union response', async () => {
  const responses = await describedResponses(variantDoc, 'createPayment')
  const ok = responses.find((response) => response.status === 200)
  assert.deepEqual(ok?.variants, ['settled', 'held'])
})

test('describe_operation reports no variants for a response that is not a union', async () => {
  // The other half of the pair. Without this, `variants` could be populated
  // unconditionally — an empty array on every object response would teach an
  // agent that `set_variant` applies where it does not.
  const responses = await describedResponses(variantDoc, 'createPayment')
  const notFound = responses.find((response) => response.status === 404)
  assert.equal(notFound?.variants, undefined)
})

test('describe_operation names variants by a formal discriminator when one is declared', async () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Events', version: '1.0.0' },
    paths: {
      '/events': {
        get: {
          operationId: 'getEvent',
          responses: {
            '200': {
              description: 'An event',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'object',
                        properties: {
                          kind: { const: 'refund' },
                          // A second const property. With `kind` declared as
                          // the discriminator only `kind` may name the branch,
                          // so a naive "first const wins" would report
                          // `pending` here and this assertion would catch it.
                          status: { const: 'pending' }
                        }
                      },
                      { type: 'object', properties: { kind: { const: 'charge' } } }
                    ],
                    discriminator: { propertyName: 'kind' }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const responses = await describedResponses(doc, 'getEvent')
  assert.deepEqual(responses[0]?.variants, ['refund', 'charge'])
})
