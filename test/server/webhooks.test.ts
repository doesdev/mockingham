import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { callbackKey } from '../../src/webhooks/emit.ts'
import { compileSchema } from '../../src/schema/compile.ts'
import type { EmitCtx } from '../../src/runtime/types.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
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
    },
    onOrderCanceled: {
      post: {
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
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    },
    '/guarded': {
      post: {
        operationId: 'guarded',
        security: [{ bearer: [] }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    },
    '/plain': {
      post: {
        operationId: 'plain',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          '201': {
            description: 'created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    },
    '/idempotent-orders': {
      post: {
        operationId: 'idempotentOrder',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
}

const api = loadApi(doc)

const subscribe = (path = '/subscriptions', headers: Record<string, string> = {}) =>
  new Request(`http://mock${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ callbackUrl: 'http://hooks.test/mine' })
  })

test('a subscribing request captures its callback url', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await handler.fetch(subscribe())
  assert.equal(
    await handler.store.get(callbackKey('onOrderShipped')),
    'http://hooks.test/mine'
  )
})

test('a rejected request captures nothing', async () => {
  // A 401 has not subscribed to anything. Capturing from it would let an
  // unauthenticated caller redirect another tenant's webhooks.
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(subscribe('/guarded'))
  assert.equal(response.status, 401)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an operation declaring no callbacks captures nothing', async () => {
  // Must exercise a request that MATCHES an operation with no callbacks —
  // not an unmatched route, which never reaches the `entry.specs.length > 0`
  // check this test's name implies it covers.
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(
    new Request('http://mock/plain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
  )
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unresolvable expression captures nothing and does not throw', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(
    new Request('http://mock/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ somethingElse: true })
    })
  )
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unsupported expression warns once at construction and is skipped', async () => {
  const warnings: string[] = []
  const unsupported = loadApi({
    ...doc,
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          responses: { '201': { description: 'created' } },
          callbacks: {
            onOrderShipped: {
              '{$request.cookie.cb}': {
                post: { responses: { '200': { description: 'ok' } } }
              }
            }
          }
        }
      }
    }
  })

  const handler = createHandler(unsupported, {
    seed: 'hooks',
    onWarn: (message) => warnings.push(message)
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /\$request\.cookie\.cb/)
  assert.match(warnings[0]!, /onOrderShipped/)

  await handler.fetch(new Request('http://mock/subscriptions', { method: 'POST' }))
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('a mixed-template expression with one unresolvable token captures nothing', async () => {
  // `resolveExpression` returns { ok: false } if ANY token in a template
  // fails. A half-substituted URL must never be captured — it would be
  // delivered somewhere unintended, which is worse than not delivering.
  const mixed = loadApi({
    ...doc,
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } }
          },
          responses: { '201': { description: 'created' } },
          callbacks: {
            onOrderShipped: {
              '{$request.body#/callbackUrl}/{$request.body#/missingToken}': {
                post: { responses: { '200': { description: 'ok' } } }
              }
            }
          }
        }
      }
    }
  })

  const handler = createHandler(mixed, { seed: 'hooks' })
  const response = await handler.fetch(subscribe())
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('emit generates a conforming payload and records the delivery', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    webhooks: { onOrderShipped: { url: 'http://hooks.test/x' } }
  })

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'captured')
  assert.equal(typeof (JSON.parse(delivery.body) as { orderId: unknown }).orderId, 'string')
  assert.deepEqual(handler.deliveries().map((d) => d.webhook), ['onOrderShipped'])
})

test('emit honors an explicit destination and a body override', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })

  const delivery = await handler.emit('onOrderShipped', {
    to: 'http://explicit.test/x',
    body: { orderId: 'o_9' }
  })

  assert.equal(delivery.url, 'http://explicit.test/x')
  assert.equal((JSON.parse(delivery.body) as { orderId: string }).orderId, 'o_9')
})

test('emit uses a url captured from an earlier subscription', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.fetch(subscribe())

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.url, 'http://hooks.test/mine')
})

test('emit resolves rather than rejecting when nothing addresses it', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const delivery = await handler.emit('onOrderShipped')
  assert.equal(delivery.outcome, 'unresolved')
})

test('captureOnly does not mask a missing destination', async () => {
  // `unresolved` is diagnostic and outranks `captured`: the mode governs
  // whether we send, not whether anything addressed the webhook. If this
  // flipped, a webhook with no destination would look healthy in every
  // captureOnly test run and deliver nowhere in production.
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  const delivery = await handler.emit('onOrderShipped')
  assert.equal(delivery.outcome, 'unresolved')
})

test('emit throws on an undeclared webhook name', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await assert.rejects(handler.emit('nope'), /nope/)
})

test('clearDeliveries empties the log', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  handler.clearDeliveries()
  assert.deepEqual(handler.deliveries(), [])
})

test('reset clears the delivery log too', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  await handler.reset()
  assert.deepEqual(handler.deliveries(), [])
})

test('two emissions of one webhook get different payloads, and a replay reproduces both', async () => {
  // Pins the design point that the payload rng is keyed by webhook name and a
  // per-name ordinal (identity plus an ordinal), not one shared advancing
  // stream. Neither property is exercised by the tests above: each of those
  // calls `emit` at most once per handler.
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  const first = await handler.emit('onOrderShipped')
  const second = await handler.emit('onOrderShipped')
  assert.notEqual(first.body, second.body)

  await handler.reset()
  const replay = [await handler.emit('onOrderShipped'), await handler.emit('onOrderShipped')]
  assert.equal(replay[0]!.body, first.body)
  assert.equal(replay[1]!.body, second.body)
})

test('two different webhooks each advance their own delivery counter', async () => {
  // The payload rng is keyed by `webhook|${name}` plus a per-name counter. A
  // regression to one shared counter across every webhook name would leave
  // every other test in this file green — none of them emits two DIFFERENT
  // webhooks from the same handler — so this compares a webhook's first
  // delivery in isolation against its first delivery after another webhook
  // has already advanced a (hypothetically) shared counter.
  const solo = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    webhooks: { onOrderCanceled: { url: 'http://hooks.test/b' } }
  })
  const soloDelivery = await solo.emit('onOrderCanceled')

  const both = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    webhooks: {
      onOrderShipped: { url: 'http://hooks.test/a' },
      onOrderCanceled: { url: 'http://hooks.test/b' }
    }
  })
  await both.emit('onOrderShipped')
  const bothDelivery = await both.emit('onOrderCanceled')

  assert.equal(bothDelivery.body, soloDelivery.body)
})

test('an operation-linked emit fires after the response and is drained by settled', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  const response = await handler.fetch(subscribe())

  // The response does not wait for the emission — §13.
  assert.equal(response.status, 201)
  assert.deepEqual(handler.deliveries(), [])

  await handler.settled()
  assert.equal(handler.deliveries().length, 1)
})

test('afterMs is awaited through the injected sleep, not the real clock', async () => {
  const slept: number[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: async (ms) => { slept.push(ms) },
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 200 }] } }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  assert.deepEqual(slept, [200])
})

test('an emit body override sees the finished response through ctx.result', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: {
      subscribe: {
        emits: [{
          webhook: 'onOrderShipped',
          body: { orderId: (ctx: EmitCtx) => `from-${ctx.result.status}` }
        }]
      }
    }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  const body = JSON.parse(handler.deliveries()[0]!.body) as { orderId: string }
  assert.equal(body.orderId, 'from-201')
})

test('an emit override receives the response body', async () => {
  // `emits` with no idempotency, no onLog, and no callbacks is the only
  // configuration in which `hasEmits` decides whether the body is captured at
  // all. `/plain` (unlike `/subscriptions`, which declares `callbacks`) has
  // none of the other three, so this is the fixture operation that isolates
  // the term: with any of the others present, `needsBody` is already true for
  // a different reason and this test would pass even with the `hasEmits`
  // term reverted.
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: {
      plain: {
        emits: [{
          webhook: 'onOrderShipped',
          body: {
            orderId: (ctx: EmitCtx) =>
              ctx.result.body === undefined ? 'MISSING' : JSON.stringify(ctx.result.body)
          }
        }]
      }
    }
  })

  const response = await handler.fetch(
    new Request('http://mock/plain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
  )
  const responseBody: unknown = await response.clone().json()
  await handler.settled()

  const emitted = JSON.parse(handler.deliveries()[0]!.body) as { orderId: string }
  assert.notEqual(emitted.orderId, 'MISSING')
  assert.deepEqual(JSON.parse(emitted.orderId), responseBody)
})

test('afterMs may be a function of the emit context', async () => {
  const slept: number[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: async (ms) => { slept.push(ms) },
    operations: {
      subscribe: {
        emits: [{ webhook: 'onOrderShipped', afterMs: (ctx: EmitCtx) => ctx.result.status }]
      }
    }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  assert.deepEqual(slept, [201])
})

test('a throwing emit override never reaches the response', async () => {
  const seen: unknown[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    onError: (error) => seen.push(error),
    operations: {
      subscribe: {
        emits: [{ webhook: 'onOrderShipped', body: { orderId: () => { throw new Error('boom') } } }]
      }
    }
  })

  const response = await handler.fetch(subscribe())
  await handler.settled()

  assert.equal(response.status, 201)
  assert.equal((seen[0] as Error).message, 'boom')
})

test('reset drops a pending emission', async () => {
  let release: (() => void) | undefined
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: () => new Promise<void>((resolve) => { release = resolve }),
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 50 }] } }
  })

  await handler.fetch(subscribe())
  await handler.reset()
  release?.()
  await handler.settled()

  assert.deepEqual(handler.deliveries(), [])
})

test('close drops a pending emission and settles', async () => {
  let release: (() => void) | undefined
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: () => new Promise<void>((resolve) => { release = resolve }),
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 50 }] } }
  })

  await handler.fetch(subscribe())
  const closing = handler.close()
  release?.()
  await closing

  assert.deepEqual(handler.deliveries(), [])
})

test('an operation with no emits config emits nothing', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.fetch(subscribe())
  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})

test('the delivered payload validates against the declared webhook schema', async () => {
  // `deliveries().length === 1` is true whether or not the payload conformed to
  // anything, and conforming is the entire point of generating it from the
  // document. Validate it with the same compiler the request path uses.
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  const schema = api.webhooks['onOrderShipped']!.body!['application/json']!.schema
  const parsed = compileSchema(schema).safeParse(JSON.parse(handler.deliveries()[0]!.body))
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})

// ── C1: emission is guarded on the response actually succeeding ──

test('a 401 blocks emission', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { guarded: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  const response = await handler.fetch(subscribe('/guarded'))
  assert.equal(response.status, 401)

  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})

test('a 400 (failed validation) blocks emission', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  // `/subscriptions` declares a `type: object` body; an array fails that.
  const response = await handler.fetch(
    new Request('http://mock/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3])
    })
  )
  assert.equal(response.status, 400)

  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})

test('an injected failure blocks emission', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    decide: () => ({ status: 503 }),
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  const response = await handler.fetch(subscribe())
  assert.equal(response.status, 503)

  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})

test('a thrown response callback (the boundary 500) blocks emission', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    onError: () => {},
    operations: {
      subscribe: {
        respond: () => { throw new Error('boom') },
        emits: [{ webhook: 'onOrderShipped' }]
      }
    }
  })

  const response = await handler.fetch(subscribe())
  assert.equal(response.status, 500)

  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})

test('a 2xx still fires the configured emit', async () => {
  // The positive control for the four blocked-path tests above: the guard
  // must not have swallowed the success case along with the failure ones.
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  const response = await handler.fetch(subscribe())
  assert.equal(response.status, 201)

  await handler.settled()
  assert.equal(handler.deliveries().length, 1)
})

// ── I4: an idempotent replay must not re-emit ──

test('an idempotent replay produces exactly one delivery, not two', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { idempotentOrder: { emits: [{ webhook: 'onOrderShipped' }] } }
  })
  const request = () =>
    new Request('http://mock/idempotent-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: JSON.stringify({})
    })

  const first = await handler.fetch(request())
  await handler.settled()
  const second = await handler.fetch(request())
  await handler.settled()

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  // Confirms the second request genuinely replayed rather than re-executing
  // and coincidentally emitting the same number of times.
  assert.equal(second.headers.get('idempotent-replay'), 'true')
  assert.equal(handler.deliveries().length, 1)
})

// ── I2: settled() and close() cover the imperative trigger too ──

test('settled() waits for an in-flight imperative emit', async () => {
  let releaseFetch: (() => void) | undefined
  let markCalled: (() => void) | undefined
  const fetchCalled = new Promise<void>((resolve) => { markCalled = resolve })
  const fetchStub = (async () => {
    markCalled?.()
    await new Promise<void>((resolve) => { releaseFetch = resolve })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  const handler = createHandler(api, {
    seed: 'hooks',
    webhooks: { onOrderShipped: { url: 'http://hooks.test/x' } },
    fetch: fetchStub
  })

  const emitting = handler.emit('onOrderShipped')
  await fetchCalled
  assert.deepEqual(handler.deliveries(), [])

  const settling = handler.settled()
  releaseFetch?.()
  await settling

  // `settled()` alone must be sufficient — not the `emitting` promise below,
  // which would complete the delivery regardless of whether `track()` was
  // ever called.
  assert.equal(handler.deliveries().length, 1)
  await emitting
})

test('close() drains an in-flight imperative emit before returning', async () => {
  let releaseFetch: (() => void) | undefined
  let markCalled: (() => void) | undefined
  const fetchCalled = new Promise<void>((resolve) => { markCalled = resolve })
  const fetchStub = (async () => {
    markCalled?.()
    await new Promise<void>((resolve) => { releaseFetch = resolve })
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch

  const handler = createHandler(api, {
    seed: 'hooks',
    webhooks: { onOrderShipped: { url: 'http://hooks.test/x' } },
    fetch: fetchStub
  })

  const emitting = handler.emit('onOrderShipped')
  await fetchCalled

  const closing = handler.close()
  releaseFetch?.()
  await closing

  // close() only returned once the in-flight delivery had actually landed —
  // draining, not dropping, an emission that is already in flight. Asserted
  // before `emitting` is awaited: the point is that `close()` alone was
  // sufficient, not that awaiting the emit promise directly completed it.
  assert.equal(handler.deliveries().length, 1)
  await emitting
})

test('emit() after close() rejects rather than silently sending', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.close()
  await assert.rejects(handler.emit('onOrderShipped'), /close/)
})

// ── I3: close() races a real timer instead of waiting it out ──

test('close() with a real (non-injected) sleep and a large afterMs returns promptly', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    // No `sleep` injected — this is the real `setTimeout` path.
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 5_000 }] } }
  })

  await handler.fetch(subscribe())
  const startedAt = Date.now()
  await handler.close()
  const elapsedMs = Date.now() - startedAt

  // Generous bound so this is not flaky, but tight enough to catch "waited
  // out the real 5s timer" outright.
  assert.ok(elapsedMs < 500, `close() took ${elapsedMs}ms`)
  // The pending emission was dropped, not delivered late.
  assert.deepEqual(handler.deliveries(), [])
})

test('settled() resolves rather than hanging after close() cancels a real timer', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 5_000 }] } }
  })

  await handler.fetch(subscribe())
  await handler.close()
  await handler.settled()

  assert.deepEqual(handler.deliveries(), [])
})

/**
 * Records which timer handles are actually cleared, so a test can assert on
 * the `clearTimeout` call itself rather than on a downstream symptom.
 *
 * Deferred item 24: the promptness tests above pass with `clearTimeout` removed
 * from `close()`, because `entry.resolve()` alone unblocks the wait. The only
 * observable difference is a real timer left running, which nothing in the
 * suite measures — so the regression it guards (a CLI shutdown hanging for up
 * to `afterMs`) could return silently. Watching the call closes that.
 */
function watchTimers() {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const created: unknown[] = []
  const cleared: unknown[] = []

  globalThis.setTimeout = ((fn: never, ms: never, ...rest: never[]) => {
    const handle = realSetTimeout(fn, ms, ...rest)
    created.push(handle)
    return handle
  }) as typeof globalThis.setTimeout

  globalThis.clearTimeout = ((handle: never) => {
    cleared.push(handle)
    return realClearTimeout(handle)
  }) as typeof globalThis.clearTimeout

  return {
    created,
    cleared,
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  }
}

test('close() clears the emission timer, not just the wait', async () => {
  const timers = watchTimers()
  try {
    const handler = createHandler(api, {
      seed: 'hooks',
      captureOnly: true,
      operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 5_000 }] } }
    })

    await handler.fetch(subscribe())
    assert.ok(timers.created.length > 0, 'the emission must arm a real timer')
    const armed = timers.created[timers.created.length - 1]

    await handler.close()

    // The exact handle, not merely "some clearTimeout happened": the runner
    // and the fetch path both use timers, so counting calls would pass on
    // unrelated traffic.
    assert.ok(
      timers.cleared.includes(armed),
      'close() must clear the timer it armed, or the process is held open'
    )
  } finally {
    timers.restore()
  }
})

test('reset() clears the emission timer too', async () => {
  // Item 25's other half, asserted the same way. The promptness of settled()
  // after reset() is the symptom; this is the cause.
  const timers = watchTimers()
  try {
    const handler = createHandler(api, {
      seed: 'hooks',
      captureOnly: true,
      operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 5_000 }] } }
    })

    await handler.fetch(subscribe())
    const armed = timers.created[timers.created.length - 1]

    await handler.reset()
    assert.ok(timers.cleared.includes(armed), 'reset() must clear it as close() does')

    await handler.settled()
    assert.deepEqual(handler.deliveries(), [])
    await handler.close()
  } finally {
    timers.restore()
  }
})
