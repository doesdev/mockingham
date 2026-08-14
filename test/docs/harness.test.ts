import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractFences, assertKnownFences } from './harness.ts'

test('extractFences returns each fence with its language and line', () => {
  const md = ['intro', '```ts', 'const a = 1', '```', 'more', '```console', 'ok', '```', ''].join('\n')
  const fences = extractFences(md)
  assert.deepEqual(
    fences.map((fence) => [fence.lang, fence.content, fence.line]),
    [
      ['ts', 'const a = 1', 2],
      ['console', 'ok', 6]
    ]
  )
})

test('extractFences preserves blank lines inside a fence', () => {
  const md = ['```ts', 'a', '', 'b', '```', ''].join('\n')
  assert.equal(extractFences(md)[0]?.content, 'a\n\nb')
})

test('an unclosed fence throws rather than silently swallowing the rest', () => {
  const md = ['```ts', 'const a = 1', ''].join('\n')
  assert.throws(() => extractFences(md), /unclosed fence/)
})

test('assertKnownFences rejects a language with no check attached', () => {
  const fences = extractFences(['```python', 'print(1)', '```', ''].join('\n'))
  assert.throws(() => assertKnownFences(fences, 'doc.md'), /python/)
})

test('assertKnownFences accepts every language the harness handles', () => {
  const md = [
    '```ts', 'const a = 1', '```',
    '```console', 'ok', '```',
    '```sh', 'npm install', '```',
    '```json', '{}', '```',
    '```jsonc', '{}', '```',
    '```txt', 'tree', '```',
    ''
  ].join('\n')
  assertKnownFences(extractFences(md), 'doc.md')
})

test('a four-backtick block containing a nested triple-backtick fence extracts as one fence', () => {
  const md = ['````markdown', '```ts', 'const a = 1', '```', '````', ''].join('\n')
  const fences = extractFences(md)
  assert.equal(fences.length, 1)
  assert.equal(fences[0]?.lang, 'markdown')
  assert.equal(fences[0]?.content, '```ts\nconst a = 1\n```')
})

test('a closing line with fewer backticks than the opener does not close the fence', () => {
  const md = ['````ts', 'const a = 1', '```', 'still in fence', '````', ''].join('\n')
  const fences = extractFences(md)
  assert.equal(fences.length, 1)
  assert.equal(fences[0]?.content, 'const a = 1\n```\nstill in fence')
})

test('a fence indented two spaces extracts with the indent stripped from content', () => {
  const md = ['  ```ts', '  const a = 1', '  const b = 2', '  ```', ''].join('\n')
  const fences = extractFences(md)
  assert.equal(fences.length, 1)
  assert.equal(fences[0]?.content, 'const a = 1\nconst b = 2')
})

import {
  assertPrintableLogs,
  assertBareSpecifier,
  checkShellFence,
  checkJsonFence,
  splitArgs
} from './fence-checks.ts'

test('a console.log of a raw object is rejected', () => {
  // util.inspect formatting is not a cross-version contract; asserting on it
  // would fail on a reader's Node for reasons unrelated to mockingham.
  // Design section 2.5.
  assert.throws(
    () => assertPrintableLogs('console.log(payment)', 'doc.md', 3),
    /JSON.stringify/
  )
})

test('strings, template literals and JSON.stringify are accepted', () => {
  assertPrintableLogs("console.log('hi')", 'doc.md', 3)
  assertPrintableLogs('console.log(`hi ${name}`)', 'doc.md', 3)
  assertPrintableLogs('console.log(JSON.stringify(payment, null, 2))', 'doc.md', 3)
})

test('a relative import into src is rejected — a reader cannot write one', () => {
  assert.throws(
    () => assertBareSpecifier("import { createMock } from '../src/index.ts'", 'doc.md', 3),
    /bare specifier/
  )
})

test('the bare package specifier is accepted', () => {
  assertBareSpecifier("import { createMock } from 'mockingham'", 'doc.md', 3)
})

test('a shell fence flag that the CLI does not accept fails', () => {
  assert.throws(
    () => checkShellFence('mockingham ./openapi.json --prot 4000', 'doc.md', 3),
    /unknown option --prot/
  )
})

test('a shell fence the CLI does accept passes, including subcommands', () => {
  checkShellFence('mockingham ./openapi.json --port 4000', 'doc.md', 3)
  checkShellFence('mockingham bake ./openapi.json --model llama3.3', 'doc.md', 3)
  checkShellFence('mockingham mcp ./openapi.json --write', 'doc.md', 3)
  checkShellFence('npm install', 'doc.md', 3)
  checkShellFence('# a comment is skipped', 'doc.md', 3)
})

test('a shell command outside the allow-set fails', () => {
  assert.throws(() => checkShellFence('curl http://example.com', 'doc.md', 3), /allow/)
})

test('an MCP client config with a bad flag fails', () => {
  const config = JSON.stringify({
    mcpServers: {
      mockingham: { command: 'npx', args: ['mockingham', 'mcp', './openapi.json', '--writes'] }
    }
  })
  assert.throws(() => checkJsonFence(config, 'doc.md', 3), /unknown option --writes/)
})

test('a valid MCP client config passes', () => {
  const config = JSON.stringify({
    mcpServers: {
      mockingham: { command: 'npx', args: ['mockingham', 'mcp', './openapi.json', '--write'] }
    }
  })
  checkJsonFence(config, 'doc.md', 3)
})

test('malformed JSON in a json fence fails', () => {
  assert.throws(() => checkJsonFence('{ nope', 'doc.md', 3), /JSON/)
})

test('a --persona flag value containing spaces passes', () => {
  checkShellFence('mockingham bake ./openapi.json --model llama3.3 --persona "A friendly banking API"', 'doc.md', 3)
})

test('a quoted value containing # is not truncated', () => {
  checkShellFence('mockingham bake ./openapi.json --model llama3.3 --persona "API #1"', 'doc.md', 3)
})

test('a trailing # comment on a valid mockingham line passes', () => {
  checkShellFence('mockingham ./openapi.json --port 4000  # start the mock', 'doc.md', 3)
})

test('a double-quoted relative import into src throws', () => {
  assert.throws(
    () => assertBareSpecifier('import { createMock } from "../src/index.ts"', 'doc.md', 3),
    /bare specifier/
  )
})

test('console.log with multiple arguments throws', () => {
  assert.throws(
    () => assertPrintableLogs("console.log('Result:', payment)", 'doc.md', 3),
    /single argument/
  )
})

test('npx -y mockingham subcommand passes', () => {
  checkShellFence('npx -y mockingham mcp ./openapi.json --write', 'doc.md', 3)
})

test('splitArgs tokenizes a double-quoted value with spaces', () => {
  const tokens = splitArgs('--persona "A friendly banking API"')
  assert.deepEqual(tokens, ['--persona', 'A friendly banking API'])
})

test('splitArgs tokenizes a single-quoted value with spaces', () => {
  const tokens = splitArgs("--persona 'A friendly API'")
  assert.deepEqual(tokens, ['--persona', 'A friendly API'])
})

test('splitArgs preserves # inside a quoted value', () => {
  const tokens = splitArgs('--persona "API #1"')
  assert.deepEqual(tokens, ['--persona', 'API #1'])
})

test('splitArgs preserves an empty quoted value', () => {
  const tokens = splitArgs('--persona "" --model llama3.3')
  assert.deepEqual(tokens, ['--persona', '', '--model', 'llama3.3'])
})

test('splitArgs tokenizes flag=value with spaces', () => {
  const tokens = splitArgs('--persona="value with spaces"')
  assert.deepEqual(tokens, ['--persona=value with spaces'])
})

test('splitArgs tokenizes correctly with complex quoting including # and spaces', () => {
  const tokens = splitArgs('mockingham bake ./openapi.json --model llama3.3 --persona "API #1: friendly"')
  assert.deepEqual(tokens, ['mockingham', 'bake', './openapi.json', '--model', 'llama3.3', '--persona', 'API #1: friendly'])
})

test('an unterminated quoted value throws', () => {
  assert.throws(
    () => splitArgs('--persona "unterminated', 'doc.md', 3),
    /unterminated quoted string/
  )
})
