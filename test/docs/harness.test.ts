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

import { assembleProgram, expectedOutput, assertDocument, runDocument } from './harness.ts'

test('assembleProgram rewrites the bare specifier to the entry path', () => {
  const fences = extractFences(
    ['```ts', "import { createMock } from 'mockingham'", '```', ''].join('\n')
  )
  const program = assembleProgram(fences, '/repo/src/index.ts')
  assert.match(program, /from "\/repo\/src\/index\.ts"/)
  assert.doesNotMatch(program, /'mockingham'/)
})

test('assembleProgram concatenates ts blocks in order and drops the rest', () => {
  const fences = extractFences(
    ['```ts', 'const a = 1', '```', '```console', 'ignored', '```', '```ts', 'const b = 2', '```', ''].join('\n')
  )
  assert.equal(assembleProgram(fences, '/x.ts'), 'const a = 1\n\nconst b = 2')
})

test('expectedOutput joins the console fences in order', () => {
  const fences = extractFences(
    ['```console', 'one', '```', '```ts', 'code', '```', '```console', 'two', '```', ''].join('\n')
  )
  assert.equal(expectedOutput(fences), 'one\ntwo')
})

test('a document whose output matches passes', async () => {
  await assertDocument(new URL('./fixtures/good.md', import.meta.url).pathname)
})

test('a document whose expected output is wrong fails, showing both sides', async () => {
  await assert.rejects(
    assertDocument(new URL('./fixtures/mismatch.md', import.meta.url).pathname),
    /operations: 5[\s\S]*operations: 4|operations: 4[\s\S]*operations: 5/
  )
})

test('a document whose program throws fails with the child stderr attached', async () => {
  await assert.rejects(
    assertDocument(new URL('./fixtures/throws.md', import.meta.url).pathname),
    /nope is not a function/
  )
})

// Fix round 1: a CRLF-terminated document must not extract zero fences and
// pass vacuously. Checking `result.stdout` directly (rather than only that
// assertDocument resolves) is deliberate — with the bug present, both the
// expected output and the actual output degrade to the empty string, so
// "does not throw" alone cannot distinguish a real pass from a vacuous one.
test('a CRLF document normalizes line endings and its fences still run', async () => {
  const result = await runDocument(new URL('./fixtures/crlf.md', import.meta.url).pathname)
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), 'operations: 4')
})

test('a document with no ts fence throws naming the file', async () => {
  await assert.rejects(
    runDocument(new URL('./fixtures/no-ts.md', import.meta.url).pathname),
    /no-ts\.md.*no ts fence/s
  )
})

test('a program that never exits is reported as a timeout, not a false exit code', async () => {
  await assert.rejects(
    assertDocument(new URL('./fixtures/hangs.md', import.meta.url).pathname, 2000),
    /did not exit within 2000ms/
  )
})

test('a mismatch error includes a stderr section, marked empty when there is none', async () => {
  await assert.rejects(
    assertDocument(new URL('./fixtures/mismatch.md', import.meta.url).pathname),
    /--- stderr ---\n\(empty\)/
  )
})
