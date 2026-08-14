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

test('write tools are absent from the default tool list', () => {
  const names = mcpTools().map((tool) => tool.name)
  for (const name of [
    'fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset',
    'set_override', 'clear_overrides'
  ]) {
    assert.ok(!names.includes(name), `${name} must not be exposed without write: true`)
  }
})

test('write tools appear when write is enabled', () => {
  const names = mcpTools({ write: true }).map((tool) => tool.name)
  assert.deepEqual(
    [
      'fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset',
      'set_override', 'clear_overrides'
    ]
      .filter((name) => names.includes(name)),
    [
      'fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset',
      'set_override', 'clear_overrides'
    ]
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
