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
