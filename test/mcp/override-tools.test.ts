import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import { toolNamed, contextFor } from './helpers.ts'
import { mcpDoc } from './doc.ts'

// getOrder inherits the document's top-level bearerAuth requirement (doc.ts).
// Auth is pipeline stage 3 while an override is applied downstream of it, so
// an unauthenticated request 401s before an override could ever be observed.
const AUTH = { authorization: 'Bearer test' }

test('both override tools are gated behind write', () => {
  const names = mcpTools().map((tool) => tool.name)
  assert.ok(!names.includes('set_override'))
  assert.ok(!names.includes('clear_overrides'))
})

test('both appear when the gate is open', () => {
  const names = mcpTools({ write: true }).map((tool) => tool.name)
  assert.ok(names.includes('set_override'))
  assert.ok(names.includes('clear_overrides'))
})

test('set_override changes what the next request returns', async () => {
  const ctx = contextFor()
  await toolNamed('set_override', { write: true }).handler(ctx, {
    target: 'getOrder',
    value: { 200: { body: { note: 'via-mcp' } } }
  })

  const response = await ctx.fetch(
    new Request('http://mock.local/orders/abc', { headers: AUTH })
  )
  const body = await response.json() as Record<string, unknown>
  assert.equal(body.note, 'via-mcp')
})

test('clear_overrides removes it again', async () => {
  const ctx = contextFor()
  await toolNamed('set_override', { write: true }).handler(ctx, {
    target: 'getOrder',
    value: { 200: { body: { note: 'via-mcp' } } }
  })
  await toolNamed('clear_overrides', { write: true }).handler(ctx, {})

  const response = await ctx.fetch(
    new Request('http://mock.local/orders/abc', { headers: AUTH })
  )
  const body = await response.json() as Record<string, unknown>
  assert.notEqual(body.note, 'via-mcp')
})

test('an unmatched target surfaces as a tool error, not a silent no-op', async () => {
  await assert.rejects(
    async () => toolNamed('set_override', { write: true }).handler(contextFor(), {
      target: 'GET /nope',
      value: { 200: { body: {} } }
    }),
    /matches no operation/
  )
})

test('tools/call refuses set_override when the gate is closed', async () => {
  // The second half of the gate, modelled on the equivalent test in
  // write.test.ts: a gate that only hides the tools from tools/list is not a
  // gate — an agent can still call one by name. server.ts derives the
  // disabled-tool registrations from WRITE_TOOLS rather than a literal list,
  // specifically so a new write tool cannot silently lose its refusal
  // message; this asserts that holds rather than trusting the comment.
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
      params: {
        name: 'set_override',
        arguments: { target: 'getOrder', value: { 200: { body: {} } } }
      }
    })
  }))

  const payload = await response.json() as {
    error?: { message: string }
    result?: { isError?: boolean; content: Array<{ text: string }> }
  }
  const message = payload.error?.message ?? payload.result?.content[0]?.text ?? ''
  assert.match(message, /write/i, `expected the refusal to name the write flag, got: ${message}`)

  // And it must not have taken effect.
  const check = await mock.fetch(new Request('http://mock.local/orders/abc', { headers: AUTH }))
  const body = await check.json() as Record<string, unknown>
  assert.notEqual(body.note, 'via-mcp')
})
