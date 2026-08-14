import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { parseMcpArgs } from '../../src/server/cli.ts'
import { mcpDoc } from '../mcp/doc.ts'

test('parseMcpArgs reads the document, seed, fixtures, and write flag', () => {
  const args = parseMcpArgs(['./doc.json', '--seed', 's', '--write'])
  assert.equal(args.document, './doc.json')
  assert.equal(args.seed, 's')
  assert.equal(args.write, true)

  assert.equal(parseMcpArgs(['./doc.json']).write, false)
})

test('a real MCP client can list and call tools over stdio', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mockingham-mcp-'))
  const docPath = join(dir, 'doc.json')
  await writeFile(docPath, JSON.stringify(mcpDoc), 'utf8')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, '../../src/server/cli.ts'), 'mcp', docPath]
  })
  const client = new Client({ name: 'test', version: '1' })

  // A stray non-JSON-RPC line on stdout does not itself hang or reject the
  // round trip: the SDK's ReadBuffer is newline-delimited, so a bad line is
  // skipped and the next well-formed message still parses. It does, however,
  // reach the transport's onerror callback as a JSON parse (or schema) error.
  // That is the actual, reliable signal that something wrote to stdout that
  // should not have — asserting on it is what makes this test fail under the
  // console.log mutation instead of passing despite the corruption.
  const streamErrors: unknown[] = []
  client.onerror = (error) => {
    streamErrors.push(error)
  }

  try {
    await client.connect(transport)

    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    assert.ok(names.includes('list_operations'), `got ${names.join(', ')}`)
    assert.ok(!names.includes('fail_next') ||
      listed.tools.find((tool) => tool.name === 'fail_next')?.description?.includes('Disabled'),
      'write tools must be disabled without --write')

    const called = await client.callTool({
      name: 'list_operations',
      arguments: { tag: 'ops' }
    }) as { content: Array<{ type: string; text: string }> }
    const operations = JSON.parse(called.content[0]!.text) as Array<{ operationId?: string }>
    assert.deepEqual(operations.map((entry) => entry.operationId), ['health'])

    assert.deepEqual(
      streamErrors,
      [],
      'the stdio transport reported a parse error, meaning something wrote a ' +
        'non-JSON-RPC line to stdout'
    )
  } finally {
    await client.close()
  }
})
