import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { contextFor, contextForMock, toolNamed } from './helpers.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import { mcpDoc } from './doc.ts'

// listOrders and getOrder inherit the document's top-level `bearerAuth`
// requirement (doc.ts). Auth is pipeline stage 3 while failure simulation is
// stage 6, so an unauthenticated request 401s before an armed failure or a
// reseed could ever be observed. These tests send credentials on every
// mock.fetch against an auth-protected operation so they exercise the write
// tools rather than the auth stage.
const AUTH = { authorization: 'Bearer test' }

// The twelve write tools, in the order WRITE_TOOLS declares them. Named once
// here rather than repeated per test: the pinned inventory assertions in
// override-tools.test.ts own the COUNT, and these own the gate.
const WRITE_TOOL_NAMES = [
  'fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset',
  'set_override', 'clear_overrides',
  'set_variant', 'clear_variants', 'redeliver_webhook',
  'register_webhook_destination', 'unregister_webhook_destination'
]

test('write tools are absent from the default tool list', () => {
  const names = mcpTools().map((tool) => tool.name)
  for (const name of WRITE_TOOL_NAMES) {
    assert.ok(!names.includes(name), `${name} must not be exposed without write: true`)
  }
})

test('write tools appear when write is enabled', () => {
  const names = mcpTools({ write: true }).map((tool) => tool.name)
  assert.deepEqual(
    WRITE_TOOL_NAMES.filter((name) => names.includes(name)),
    WRITE_TOOL_NAMES
  )
})

test('tools/call refuses a write tool when the gate is closed', async () => {
  // The second half of the gate. A gate that only hides the tools from
  // tools/list is not a gate — an agent can still call one by name.
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const response = await mock.fetch(new Request('http://mock.local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'fail_next', arguments: { target: 'GET /orders' } }
    })
  }))

  const payload = await response.json() as {
    error?: { message: string }
    result?: { isError?: boolean; content: Array<{ text: string }> }
  }
  const message = payload.error?.message ?? payload.result?.content[0]?.text ?? ''
  assert.match(message, /write/i, `expected the refusal to name the write flag, got: ${message}`)

  // And it must not have taken effect. Credentials required: GET /orders
  // inherits the document's bearerAuth requirement.
  const check = await mock.fetch(new Request('http://mock.local/orders', { headers: AUTH }))
  assert.equal(check.status, 200)
})

test('fail_next drives the next request to an error when the gate is open', async () => {
  const mock = createMock(mcpDoc)
  const ctx = contextForMock(mock)
  await toolNamed('fail_next', { write: true }).handler(ctx, {
    target: 'GET /orders', status: 503
  })

  const failed = await mock.fetch(new Request('http://mock.local/orders', { headers: AUTH }))
  assert.equal(failed.status, 503)
  const recovered = await mock.fetch(new Request('http://mock.local/orders', { headers: AUTH }))
  assert.equal(recovered.status, 200)
})

test('a mistyped target becomes a tool error, not a crash', async () => {
  await assert.rejects(
    async () => toolNamed('fail_next', { write: true }).handler(contextFor(), {
      target: 'POST /no-such-path'
    }),
    /no-such-path/
  )
})

test('emit_webhook returns an unresolved delivery rather than erroring', async () => {
  // Invariant 6: an emit that resolves no destination is captured as
  // unresolved, not raised. An agent told "error" would conclude its receiver
  // is broken when the mock simply had no URL to send to.
  const mock = createMock(mcpDoc)
  const delivery = (await toolNamed('emit_webhook', { write: true }).handler(
    contextForMock(mock), { webhook: 'orderCreated' }
  )) as { outcome: string }

  assert.equal(delivery.outcome, 'unresolved')
})

test('emit_webhook can address a scoped registration', async () => {
  // Without a scope argument an agent can register scoped destinations through
  // register_webhook_destination and then never reach them, which leaves the
  // scoped registry half-exposed over the surface it was built for.
  const mock = createMock(mcpDoc)
  const ctx = contextForMock(mock)

  await toolNamed('register_webhook_destination', { write: true }).handler(ctx, {
    webhook: 'orderCreated', url: 'http://hooks.test/tenant-a', scope: 'tenant-a'
  })
  await toolNamed('register_webhook_destination', { write: true }).handler(ctx, {
    webhook: 'orderCreated', url: 'http://hooks.test/tenant-b', scope: 'tenant-b'
  })

  // Two scopes in the fixture: with one, a tool that ignored `scope` entirely
  // would still deliver to the only registration and the test would pass.
  const toA = await toolNamed('emit_webhook', { write: true }).handler(ctx, {
    webhook: 'orderCreated', scope: 'tenant-a'
  }) as { url?: string }
  const toB = await toolNamed('emit_webhook', { write: true }).handler(ctx, {
    webhook: 'orderCreated', scope: 'tenant-b'
  }) as { url?: string }

  assert.equal(toA.url, 'http://hooks.test/tenant-a')
  assert.equal(toB.url, 'http://hooks.test/tenant-b')

  // And no scope still addresses the unscoped registration, of which there is
  // none — so it is unresolved rather than silently picking a tenant.
  const unscoped = await toolNamed('emit_webhook', { write: true }).handler(ctx, {
    webhook: 'orderCreated'
  }) as { outcome: string }
  assert.equal(unscoped.outcome, 'unresolved')
})

test('set_seed and reset take effect through the tools', async () => {
  const mock = createMock(mcpDoc, { seed: 'first' })
  const ctx = contextForMock(mock)

  // Credentials required: getOrder inherits bearerAuth. /health would avoid
  // auth entirely, but its body is a single boolean — too few values for a
  // "the body changed with the seed" comparison to mean anything.
  const before = await (await mock.fetch(
    new Request('http://mock.local/orders/abc', { headers: AUTH })
  )).json()
  await toolNamed('set_seed', { write: true }).handler(ctx, { seed: 'second' })
  const after = await (await mock.fetch(
    new Request('http://mock.local/orders/abc', { headers: AUTH })
  )).json()
  assert.notDeepEqual(before, after)

  await toolNamed('fail_next', { write: true }).handler(ctx, { target: 'GET /orders' })
  await toolNamed('reset', { write: true }).handler(ctx, {})
  const recovered = await mock.fetch(new Request('http://mock.local/orders', { headers: AUTH }))
  assert.equal(recovered.status, 200, 'reset must clear armed failures')
})

// --- set_variant / clear_variants (design §5.5) -----------------------------

/**
 * Two branches separated by a const property and nothing else, so only the
 * variant preference or the seeded pick can decide between them. Modelled on
 * test/server/variant.test.ts, and deliberately carrying no `security`: auth
 * is pipeline stage 3, so a declared scheme would 401 every request below.
 */
const union = {
  oneOf: [
    {
      type: 'object',
      required: ['outcome', 'id'],
      properties: { outcome: { const: 'created' }, id: { type: 'string' } }
    },
    {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { const: 'conflict' } }
    }
  ]
}

const unionDoc = {
  openapi: '3.1.0',
  info: { title: 'variants', version: '1' },
  paths: {
    '/upsert': {
      post: {
        operationId: 'upsert',
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: union } } }
        }
      }
    }
  }
}

const VARIANT_SEED = 'variants'
/**
 * The seeded pick for this document under this seed, pinned exactly as
 * test/server/variant.test.ts pins it. Every test below asks for the OTHER
 * branch — otherwise a tool that stored nothing at all would still pass.
 */
const SEEDED_OUTCOME = 'created'
const REQUESTED_OUTCOME = 'conflict'

const upsertOnce = async (mock: { fetch(request: Request): Promise<Response> }) =>
  (await (await mock.fetch(
    new Request('http://mock.local/upsert', { method: 'POST' })
  )).json()) as Record<string, unknown>

test('the variant tests ask for a branch the seed does not already pick', async () => {
  const mock = createMock(unionDoc, { seed: VARIANT_SEED })
  assert.equal(
    (await upsertOnce(mock)).outcome,
    SEEDED_OUTCOME,
    'the seeded pick must differ from the branch the tests below request, or ' +
      'none of them can fail'
  )
  assert.notEqual(SEEDED_OUTCOME, REQUESTED_OUTCOME)
})

test('set_variant steers what the next request generates', async () => {
  const mock = createMock(unionDoc, { seed: VARIANT_SEED })
  const ctx = contextForMock(mock)

  const result = await toolNamed('set_variant', { write: true }).handler(ctx, {
    target: 'upsert', name: REQUESTED_OUTCOME
  })
  assert.deepEqual(result, { target: 'upsert', variant: REQUESTED_OUTCOME })

  // The effect, through the mock — not the echoed return value. A handler that
  // built that object and called nothing would pass on the line above alone.
  const body = await upsertOnce(mock)
  assert.equal(body.outcome, REQUESTED_OUTCOME)
  assert.equal(body.id, undefined, 'the conflict branch declares no id')
})

test('clear_variants with no target restores the seeded branch and echoes null', async () => {
  const mock = createMock(unionDoc, { seed: VARIANT_SEED })
  const ctx = contextForMock(mock)
  await toolNamed('set_variant', { write: true }).handler(ctx, {
    target: 'upsert', name: REQUESTED_OUTCOME
  })

  const result = await toolNamed('clear_variants', { write: true }).handler(ctx, {})
  // `null`, never '*'. A bare '*' is not a valid target — compileTarget reads a
  // space-free string as an operationId — so echoing it would teach a calling
  // agent a string that throws on its next call. Exactly the bug that shipped
  // in fail_next's description until plan 10 corrected it.
  assert.deepEqual(result, { cleared: null })

  assert.equal((await upsertOnce(mock)).outcome, SEEDED_OUTCOME)
})

test('clear_variants with a target clears that operation and echoes it back', async () => {
  const mock = createMock(unionDoc, { seed: VARIANT_SEED })
  const ctx = contextForMock(mock)
  await toolNamed('set_variant', { write: true }).handler(ctx, {
    target: 'upsert', name: REQUESTED_OUTCOME
  })

  const result = await toolNamed('clear_variants', { write: true }).handler(ctx, {
    target: 'upsert'
  })
  assert.deepEqual(result, { cleared: 'upsert' })
  assert.equal((await upsertOnce(mock)).outcome, SEEDED_OUTCOME)
})

test('set_variant on a target matching nothing is a tool error, not a silent store', async () => {
  await assert.rejects(
    async () => toolNamed('set_variant', { write: true }).handler(
      contextFor(unionDoc, { seed: VARIANT_SEED }),
      { target: 'nosuchop', name: REQUESTED_OUTCOME }
    ),
    (error: Error) => {
      assert.equal(
        error.message,
        'mockingham: target "nosuchop" matches no operation in the document. ' +
          'Check the method, the path template exactly as written in the ' +
          'document, or the operationId.'
      )
      return true
    }
  )
})

// --- redeliver_webhook (design §7.3) ----------------------------------------

test('redeliver_webhook re-sends the recorded bytes under the same id', async () => {
  const mock = createMock(mcpDoc, {
    seed: 'redeliver',
    captureOnly: true,
    webhooks: { orderCreated: { url: 'http://hooks.test/h' } }
  })
  const ctx = contextForMock(mock)

  const first = await mock.emit('orderCreated')
  const again = await toolNamed('redeliver_webhook', { write: true }).handler(ctx, {
    id: first.id
  }) as { id: string; body: string; url?: string }

  assert.equal(again.id, first.id, 'a redelivery keeps the original identity')
  assert.equal(again.body, first.body)
  assert.equal(again.url, 'http://hooks.test/h')
  // The effect through the mock: a second record in the log, not merely a
  // returned object. A handler that echoed the existing record would fail here.
  assert.deepEqual(
    mock.deliveries().map((delivery) => delivery.id),
    [first.id, first.id]
  )
})

test('a redelivery that fails comes back as a failed delivery, never a throw', async () => {
  // Invariant 6, as emit_webhook already honors it: a failed delivery is a
  // recorded outcome. Only an unknown or aged-out id is a caller error.
  const mock = createMock(mcpDoc, {
    seed: 'redeliver',
    webhooks: { orderCreated: { url: 'http://hooks.test/h', retry: { attempts: 1 } } },
    fetch: async () => new Response('no', { status: 500 }),
    sleep: async () => {}
  })
  const ctx = contextForMock(mock)

  const first = await mock.emit('orderCreated')
  assert.equal(first.outcome, 'failed', 'precondition: the first send failed')

  const again = await toolNamed('redeliver_webhook', { write: true }).handler(ctx, {
    id: first.id
  }) as { id: string; outcome: string; status?: number }
  assert.equal(again.outcome, 'failed')
  assert.equal(again.status, 500)
  assert.equal(again.id, first.id)
})

test('an unknown delivery id is a tool error with the log-bound message', async () => {
  const ctx = contextFor(mcpDoc, { captureOnly: true })
  await assert.rejects(
    async () => toolNamed('redeliver_webhook', { write: true }).handler(ctx, { id: 'nope' }),
    (error: Error) => {
      assert.equal(
        error.message,
        'mockingham: no delivery with id "nope" is in the delivery log. ' +
          'Redeliver an id returned by emit() or listed by deliveries().'
      )
      return true
    }
  )
})

// --- register / unregister_webhook_destination (design §3.5) ----------------

test('register_webhook_destination makes an unresolved emit resolve', async () => {
  const mock = createMock(mcpDoc, { seed: 'registry', captureOnly: true })
  const ctx = contextForMock(mock)

  const before = await mock.emit('orderCreated')
  assert.equal(before.outcome, 'unresolved', 'precondition: nothing supplies a url')

  const result = await toolNamed('register_webhook_destination', { write: true }).handler(ctx, {
    webhook: 'orderCreated', url: 'http://hooks.test/registered'
  })
  assert.deepEqual(result, {
    webhook: 'orderCreated', url: 'http://hooks.test/registered', scope: ''
  })

  // Two independent readings of the effect: the registry itself, and an
  // emission actually resolving through it.
  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderCreated', url: 'http://hooks.test/registered', scope: '' }
  ])
  const after = await mock.emit('orderCreated')
  assert.equal(after.outcome, 'captured')
  assert.equal(after.url, 'http://hooks.test/registered')
})

test('register_webhook_destination stores under the scope it is given', async () => {
  const mock = createMock(mcpDoc, { seed: 'registry', captureOnly: true })
  const ctx = contextForMock(mock)

  await toolNamed('register_webhook_destination', { write: true }).handler(ctx, {
    webhook: 'orderCreated', url: 'http://hooks.test/tenant-a', scope: 'tenant-a'
  })

  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderCreated', url: 'http://hooks.test/tenant-a', scope: 'tenant-a' }
  ])
  // A scoped registration does not answer the unscoped lookup — design §3.4.
  // Without this, a handler that dropped `scope` on the floor would still pass
  // the assertion above only by accident of it being the sole entry.
  const emitted = await mock.emit('orderCreated')
  assert.equal(emitted.outcome, 'unresolved')
})

test('unregister_webhook_destination removes the registration', async () => {
  const mock = createMock(mcpDoc, { seed: 'registry', captureOnly: true })
  const ctx = contextForMock(mock)
  await mock.register('orderCreated', 'http://hooks.test/registered')
  await mock.register('orderCreated', 'http://hooks.test/tenant-a', 'tenant-a')

  const result = await toolNamed('unregister_webhook_destination', { write: true })
    .handler(ctx, { webhook: 'orderCreated' })
  assert.deepEqual(result, { webhook: 'orderCreated', scope: '' })

  // Only the unscoped one goes: an unregister that ignored `scope` and cleared
  // everything would fail here.
  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderCreated', url: 'http://hooks.test/tenant-a', scope: 'tenant-a' }
  ])
  const emitted = await mock.emit('orderCreated')
  assert.equal(emitted.outcome, 'unresolved')
})

test('unregister_webhook_destination removes the scoped registration when scoped', async () => {
  const mock = createMock(mcpDoc, { seed: 'registry', captureOnly: true })
  const ctx = contextForMock(mock)
  await mock.register('orderCreated', 'http://hooks.test/registered')
  await mock.register('orderCreated', 'http://hooks.test/tenant-a', 'tenant-a')

  const result = await toolNamed('unregister_webhook_destination', { write: true })
    .handler(ctx, { webhook: 'orderCreated', scope: 'tenant-a' })
  assert.deepEqual(result, { webhook: 'orderCreated', scope: 'tenant-a' })

  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderCreated', url: 'http://hooks.test/registered', scope: '' }
  ])
})
