import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import { mcpDoc } from './doc.ts'

function rpc(body: unknown): Request {
  return new Request('http://mock.local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  })
}

test('tools/list reaches the mount through mock.fetch, with no initialize', async () => {
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const response = await mock.fetch(
    rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')

  const payload = await response.json() as {
    result: { tools: Array<{ name: string }> }
  }
  const names = payload.result.tools.map((tool) => tool.name)
  assert.ok(names.includes('list_operations'), `expected list_operations in ${names}`)
})

test('tools/call runs the real tool against the real document', async () => {
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const response = await mock.fetch(rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_operations', arguments: { tag: 'ops' } }
  }))

  const payload = await response.json() as {
    result: { content: Array<{ type: string; text: string }> }
  }
  const operations = JSON.parse(payload.result.content[0]!.text) as
    Array<{ operationId?: string }>
  assert.deepEqual(operations.map((entry) => entry.operationId), ['health'])
})

test('each request is independent — a second call succeeds', async () => {
  // The stateless transport throws if reused, so this fails loudly the moment
  // someone caches the server or transport across requests. Design §3.4.
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const first = await mock.fetch(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  const second = await mock.fetch(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  const payload = await second.json() as { id: number; result: unknown }
  assert.equal(payload.id, 2)
})

test('a client that does handshake still works', async () => {
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const response = await mock.fetch(rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    }
  }))

  const payload = await response.json() as { result: { protocolVersion: string } }
  assert.ok(payload.result.protocolVersion, 'initialize must negotiate a version')
})

test('mcp() works after listen(), not only before', async () => {
  const mock = createMock(mcpDoc)
  const address = await mock.listen(0)
  try {
    mock.mcp({ transport: 'http', path: '/mcp' })
    const response = await fetch(`${address.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
    assert.equal(response.status, 200)
  } finally {
    await mock.close()
  }
})

test('paths other than the mount still reach the mock', async () => {
  const mock = createMock(mcpDoc)
  mock.mcp({ transport: 'http', path: '/mcp' })

  const response = await mock.fetch(new Request('http://mock.local/health'))
  assert.equal(response.status, 200)
  const body = await response.json() as { ok?: boolean }
  assert.equal(typeof body.ok, 'boolean')
})

test('a document operation at the mount path is shadowed, with a warning', async () => {
  const warnings: string[] = []
  const doc = {
    ...mcpDoc,
    paths: {
      ...mcpDoc.paths,
      '/mcp': {
        get: { operationId: 'mcpOperation', tags: [], responses: { '200': { description: 'ok' } } }
      }
    }
  }
  const mock = createMock(doc, { onWarn: (message) => warnings.push(message) })
  mock.mcp({ transport: 'http', path: '/mcp' })

  assert.ok(
    warnings.some((message) => message.includes('/mcp') && message.includes('shadow')),
    `expected a shadowing warning, got ${JSON.stringify(warnings)}`
  )
})
