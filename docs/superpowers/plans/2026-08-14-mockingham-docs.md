# mockingham Phase 12 — Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the README, four guides, and the shared example document that
phase 12 calls for, with every code block in them executed and asserted by the
test suite.

**Architecture:** A harness in `test/docs/` reads each markdown file,
concatenates its ```ts fences into one program, runs that program in a child
process inside a sandbox directory, and compares stdout byte-for-byte against
the file's own ```console fences. Fences that cannot be executed get targeted
checks instead — shell lines are fed to the real CLI parser, the MCP client
config is parsed and its flags checked — and an unrecognized fence language is a
test failure. No file under `src/` changes in this plan.

**Tech Stack:** TypeScript run directly by Node 24's native type stripping,
`node:test`, `node:child_process`, `zod` (already the only runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-14-mockingham-docs-design.md`
Read it before Task 1. The master contract is
`docs/superpowers/specs/2026-08-11-mockingham-design.md` §18 (phase 12), and
the delta wins wherever they disagree.

## Global Constraints

- **No file under `src/` is modified by this plan.** Not one line. If a task
  appears to need a source change, stop and record it as a deferred item
  instead — spec §1, §7.
- **Node >= 24.2.0**, ESM, erasable syntax only: no `enum`, no `namespace`, no
  parameter properties. Use `const X = {...} as const`.
- **US English spelling** everywhere — `honor`, `behavior`, `serialize`,
  `normalize`, `canceled`.
- **One plain command per Bash call, with literal arguments.** No `&&`, no
  pipes, no `$(...)`, no redirects, no heredocs, no `cd`. Use the Write tool for
  files. This is CLAUDE.md's shell contract and it is not optional.
- **Tests live in `test/` mirroring `src/`**, written in TypeScript, run by
  `node:test`. Write the test first, watch it fail, then implement.
- `npm test` runs `node --test 'test/**/*.test.ts'`. `npx tsc --noEmit` must stay
  clean.
- **Docs cite, they do not restate.** Where a guide states a rule, it names the
  invariant or spec section the rule comes from — spec §4.
- **Nothing in the docs suite reaches the network.** Every provider, sink, and
  destination is injected.

---

## File Structure

**Created by this plan:**

| File | Responsibility |
|---|---|
| `docs/example.json` | The one OpenAPI document every guide runs against |
| `test/docs/harness.ts` | Fence extraction, program assembly, child execution, comparison |
| `test/docs/fence-checks.ts` | Per-language checks: `console.log` guard, `sh`, `json` |
| `test/docs/harness.test.ts` | Unit tests for both of the above, against throwaway fixtures |
| `test/docs/fixtures/*.md` | Deliberately good and deliberately wrong documents |
| `test/docs/example-doc.test.ts` | Pins the shape of `docs/example.json` |
| `test/docs/docs.test.ts` | One subtest per real document, plus the coverage assertion |
| `README.md` | The public front door |
| `docs/logging-datadog.md` | `LogRecord` → batching sink → Datadog intake |
| `docs/fixtures.md` | The bake → commit → serve loop |
| `docs/webhooks.md` | Testing callbacks and webhooks |
| `docs/mcp.md` | MCP setup, both transports, client config |

**Modified by this plan:**

| File | Change |
|---|---|
| `CLAUDE.md:15` | Its run command starts working (Task 10) |
| `docs/superpowers/specs/2026-08-11-mockingham-design.md` | §1 phantom method, §19 limitations (Task 10) |
| `docs/superpowers/deferred-items.md` | Rulings for everything found and not fixed (Task 10) |

**The sandbox convention, decided once here so every guide reads naturally:**
each document runs in a fresh temp directory containing a copy of
`docs/example.json` named `openapi.json`. The child's `cwd` is that directory.
So a guide writes `readFile('./openapi.json', 'utf8')` — the path a reader
actually has — and it resolves. Fixture directories the guides create land in
the same sandbox and vanish with it.

---

## Task 1: The example document

**Files:**
- Create: `docs/example.json`
- Test: `test/docs/example-doc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/example.json`, an OpenAPI 3.1.0 document with
  `operationId`s `createPayment`, `getPayment`, `listPayments`, `createRefund`;
  security schemes `bearerAuth` (http/bearer) and `apiKeyAuth` (apiKey, header
  `X-Api-Key`); a `paymentSucceeded` callback on `createPayment`; a top-level
  `paymentFailed` webhook. Every later task runs against these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/docs/example-doc.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadApi } from '../../src/spec/load.ts'

const doc = JSON.parse(
  await readFile(new URL('../../docs/example.json', import.meta.url), 'utf8')
) as Record<string, unknown>

test('the example document loads and declares the operations the guides use', () => {
  const api = loadApi(doc)
  const ids = api.operations.map((operation) => operation.operationId).sort()
  assert.deepEqual(ids, [
    'createPayment',
    'createRefund',
    'getPayment',
    'listPayments'
  ])
})

test('it declares both security schemes the auth guide shows', () => {
  const api = loadApi(doc)
  assert.deepEqual(Object.keys(api.securitySchemes).sort(), [
    'apiKeyAuth',
    'bearerAuth'
  ])
})

test('createPayment declares the callback the webhook guide fires', () => {
  const api = loadApi(doc)
  const create = api.operations.find((o) => o.operationId === 'createPayment')
  assert.ok(create, 'createPayment must exist')
  assert.deepEqual(
    create.callbacks.map((callback) => callback.name),
    ['paymentSucceeded']
  )
})

test('a top-level webhook is declared for the failure path', () => {
  const api = loadApi(doc)
  assert.deepEqual(Object.keys(api.webhooks), ['paymentFailed'])
})

test('every operation carries a tag, so the MCP search tools have something real', () => {
  const api = loadApi(doc)
  for (const operation of api.operations) {
    assert.ok(operation.tags.length > 0, `${operation.operationId} needs a tag`)
  }
})
```

**These are the real shapes, already checked against `src/spec/types.ts`:**
`Api` is `{ version, operations, schemaNames, securitySchemes, webhooks }`
where `webhooks` is a `Record<string, WebhookSpec>` keyed by name — a top-level
`webhooks` entry only. A **callback is not a webhook** at this layer: it lands
on `Operation.callbacks` as a `CallbackSpec[]`, because its destination is a
runtime expression that can only be resolved against a live request. The two
assertions above test the two different places on purpose.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/docs/example-doc.test.ts`
Expected: FAIL — `ENOENT`, no `docs/example.json`.

- [ ] **Step 3: Write the document**

Create `docs/example.json`. It must contain, at minimum:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Example Payments API", "version": "1.0.0" },
  "paths": {
    "/payments": {
      "get": {
        "operationId": "listPayments",
        "tags": ["payments"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          {
            "name": "status",
            "in": "query",
            "schema": { "type": "array", "items": { "type": "string", "enum": ["pending", "succeeded", "failed"] } }
          },
          { "name": "limit", "in": "query", "schema": { "type": "integer", "minimum": 1, "maximum": 100 } }
        ],
        "responses": {
          "200": {
            "description": "A page of payments",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["data"],
                  "properties": {
                    "data": { "type": "array", "items": { "$ref": "#/components/schemas/Payment" } },
                    "nextCursor": { "type": ["string", "null"] }
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "operationId": "createPayment",
        "tags": ["payments"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "name": "Idempotency-Key", "in": "header", "schema": { "type": "string" } }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["amount", "currency"],
                "properties": {
                  "amount": { "type": "number", "minimum": 0.01, "multipleOf": 0.01 },
                  "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
                  "description": { "type": "string" },
                  "callbackUrl": { "type": "string", "format": "uri" }
                }
              }
            }
          }
        },
        "responses": {
          "201": {
            "description": "Created",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Payment" } } }
          },
          "422": {
            "description": "Invalid",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
          }
        },
        "callbacks": {
          "paymentSucceeded": {
            "{$request.body#/callbackUrl}": {
              "post": {
                "operationId": "paymentSucceededCallback",
                "requestBody": {
                  "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Payment" } } }
                },
                "responses": { "200": { "description": "ack" } }
              }
            }
          }
        }
      }
    },
    "/payments/{id}": {
      "get": {
        "operationId": "getPayment",
        "tags": ["payments"],
        "security": [{ "bearerAuth": [] }],
        "parameters": [
          { "name": "id", "in": "path", "required": true, "schema": { "type": "string", "format": "uuid" } }
        ],
        "responses": {
          "200": {
            "description": "The payment",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Payment" } } }
          },
          "404": {
            "description": "No such payment",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } }
          }
        }
      }
    },
    "/refunds": {
      "post": {
        "operationId": "createRefund",
        "tags": ["refunds"],
        "security": [{ "apiKeyAuth": [] }],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["paymentId"],
                "properties": {
                  "paymentId": { "type": "string", "format": "uuid" },
                  "amount": { "type": "number", "minimum": 0.01, "multipleOf": 0.01 }
                }
              }
            }
          }
        },
        "responses": {
          "202": {
            "description": "Accepted",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": ["id", "status"],
                  "properties": {
                    "id": { "type": "string", "format": "uuid" },
                    "status": { "type": "string", "enum": ["pending", "succeeded", "failed"] }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "webhooks": {
    "paymentFailed": {
      "post": {
        "operationId": "paymentFailedWebhook",
        "requestBody": {
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Payment" } } }
        },
        "responses": { "200": { "description": "ack" } }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer" },
      "apiKeyAuth": { "type": "apiKey", "in": "header", "name": "X-Api-Key" }
    },
    "schemas": {
      "Payment": {
        "type": "object",
        "required": ["id", "amount", "currency", "status", "createdAt"],
        "properties": {
          "id": { "type": "string", "format": "uuid" },
          "amount": { "type": "number", "minimum": 0.01, "multipleOf": 0.01 },
          "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
          "status": { "type": "string", "enum": ["pending", "succeeded", "failed"] },
          "description": { "type": "string" },
          "createdAt": { "type": "string", "format": "date-time" }
        }
      },
      "Error": {
        "type": "object",
        "required": ["code", "message"],
        "properties": {
          "code": { "type": "string" },
          "message": { "type": "string" },
          "requestId": { "type": "string" }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `node --test test/docs/example-doc.test.ts`
Expected: PASS, 5 tests.

The `callbackUrl` property on `createPayment`'s request body is load-bearing:
the callback's runtime expression is `{$request.body#/callbackUrl}`, so without
that property there is nothing for it to resolve against and Task 6's guide
would have to document a callback that can never fire.

- [ ] **Step 5: Prove the document actually serves**

Run: `node src/server/cli.ts docs/example.json --port 4100`
Expected: it starts and prints a listening line. Stop it with Ctrl-C. If it
warns about an unsupported `pattern` or runtime expression, that warning is
information the guides must carry — write it into the task ledger now.

- [ ] **Step 6: Commit**

```sh
git add docs/example.json test/docs/example-doc.test.ts
```

```sh
git commit -m 'docs: the canonical example payments document'
```

---

## Task 2: Fence extraction

**Files:**
- Create: `test/docs/harness.ts`
- Test: `test/docs/harness.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Fence { lang: string; content: string; line: number }`
  - `extractFences(markdown: string): Fence[]`
  - `const KNOWN_LANGS: ReadonlySet<string>`
  - `assertKnownFences(fences: Fence[], file: string): void`

- [ ] **Step 1: Write the failing test**

Create `test/docs/harness.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/docs/harness.test.ts`
Expected: FAIL — cannot resolve `./harness.ts`.

- [ ] **Step 3: Implement extraction**

Create `test/docs/harness.ts`:

```ts
export interface Fence {
  lang: string
  content: string
  /** 1-based line of the opening fence, for error messages that point somewhere. */
  line: number
}

/**
 * Line-based rather than a regex. A regex over fenced markdown gets the
 * nesting and the trailing-newline cases wrong in ways that are invisible
 * until a doc happens to hit one.
 */
export function extractFences(markdown: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let open: { lang: string; line: number; body: string[] } | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (!line.startsWith('```')) {
      if (open !== undefined) open.body.push(line)
      continue
    }
    if (open === undefined) {
      open = { lang: line.slice(3).trim(), line: i + 1, body: [] }
    } else {
      fences.push({ lang: open.lang, content: open.body.join('\n'), line: open.line })
      open = undefined
    }
  }

  if (open !== undefined) {
    throw new Error(`unclosed fence opened at line ${open.line}`)
  }
  return fences
}

/**
 * Every language the harness knows how to check. An unrecognized one fails
 * rather than being ignored: a checked-in exemption list is a list that goes
 * stale silently, so adding a new kind of block has to be a decision someone
 * makes on purpose. Design section 2.3.
 */
export const KNOWN_LANGS: ReadonlySet<string> = new Set([
  'ts',
  'console',
  'sh',
  'json',
  'jsonc',
  'txt'
])

export function assertKnownFences(fences: Fence[], file: string): void {
  for (const fence of fences) {
    if (!KNOWN_LANGS.has(fence.lang)) {
      throw new Error(
        `${file}:${fence.line}: fence language "${fence.lang}" has no check ` +
          `attached. Known: ${[...KNOWN_LANGS].join(', ')}.`
      )
    }
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test test/docs/harness.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```sh
git add test/docs/harness.ts test/docs/harness.test.ts
```

```sh
git commit -m 'test: fence extraction for the docs harness'
```

---

## Task 3: The per-language fence checks

**Files:**
- Create: `test/docs/fence-checks.ts`
- Modify: `test/docs/harness.test.ts` (append)

**Interfaces:**
- Consumes: `Fence` from `./harness.ts`.
- Produces:
  - `assertPrintableLogs(block: string, file: string, line: number): void`
  - `assertBareSpecifier(block: string, file: string, line: number): void`
  - `checkShellFence(content: string, file: string, line: number): void`
  - `checkJsonFence(content: string, file: string, line: number): void`

- [ ] **Step 1: Write the failing tests**

Append to `test/docs/harness.test.ts`:

```ts
import {
  assertPrintableLogs,
  assertBareSpecifier,
  checkShellFence,
  checkJsonFence
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
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/docs/harness.test.ts`
Expected: FAIL — cannot resolve `./fence-checks.ts`.

- [ ] **Step 3: Implement the checks**

Create `test/docs/fence-checks.ts`:

```ts
import { parseArgs, parseBakeArgs, parseMcpArgs } from '../../src/server/cli.ts'

/**
 * A prefix check rather than a parse. The rule only needs to distinguish
 * "prints a string" from "prints whatever util.inspect feels like today", and
 * a real expression parser here would be more machinery than the rule is
 * worth. Design section 2.5.
 */
export function assertPrintableLogs(block: string, file: string, line: number): void {
  const marker = 'console.log('
  for (let at = block.indexOf(marker); at !== -1; at = block.indexOf(marker, at + 1)) {
    const rest = block.slice(at + marker.length)
    const ok =
      rest.startsWith("'") ||
      rest.startsWith('"') ||
      rest.startsWith('`') ||
      rest.startsWith('JSON.stringify(')
    if (!ok) {
      throw new Error(
        `${file}:${line}: console.log must print a string, a template literal, ` +
          'or JSON.stringify(value, null, 2) — util.inspect output is not stable ' +
          'across Node versions.'
      )
    }
  }
}

/**
 * The docs must import the way a reader can. A relative path into `src/` would
 * run fine here and be uncopyable there — the exact drift this harness exists
 * to catch.
 */
export function assertBareSpecifier(block: string, file: string, line: number): void {
  const pattern = /from\s+'([^']+)'/g
  for (const match of block.matchAll(pattern)) {
    const specifier = match[1] as string
    if (specifier.startsWith('node:') || specifier === 'mockingham') continue
    throw new Error(
      `${file}:${line}: import from "${specifier}" — docs must use the bare ` +
        'specifier \'mockingham\' or a node: builtin.'
    )
  }
}

const SHELL_ALLOW = [
  'npm install',
  'npm test',
  'npx tsc --noEmit',
  'ollama serve',
  'ollama pull'
] as const

function splitArgs(line: string): string[] {
  return line
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^["']|["']$/g, ''))
}

/** Routes to the same parser the running CLI uses, subcommand included. */
function checkMockinghamArgs(argv: string[]): void {
  if (argv[0] === 'bake') parseBakeArgs(argv.slice(1))
  else if (argv[0] === 'mcp') parseMcpArgs(argv.slice(1))
  else parseArgs(argv)
}

export function checkShellFence(content: string, file: string, line: number): void {
  for (const raw of content.split('\n')) {
    const command = raw.trim()
    if (command === '' || command.startsWith('#')) continue

    const withoutNpx = command.startsWith('npx mockingham ')
      ? command.slice('npx '.length)
      : command

    if (withoutNpx === 'mockingham' || withoutNpx.startsWith('mockingham ')) {
      checkMockinghamArgs(splitArgs(withoutNpx).slice(1))
      continue
    }

    if (!SHELL_ALLOW.some((allowed) => command === allowed || command.startsWith(`${allowed} `))) {
      throw new Error(
        `${file}:${line}: shell command "${command}" is not a mockingham ` +
          `invocation and is not on the allow-set (${SHELL_ALLOW.join(', ')}).`
      )
    }
  }
}

interface McpClientConfig {
  mcpServers?: Record<string, { command?: string; args?: string[] }>
}

export function checkJsonFence(content: string, file: string, line: number): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(
      `${file}:${line}: fence is not valid JSON — ${(error as Error).message}`
    )
  }

  const servers = (parsed as McpClientConfig).mcpServers
  if (servers === undefined) return

  for (const [name, server] of Object.entries(servers)) {
    const argv = server.args ?? []
    // `npx mockingham mcp ...` and `mockingham mcp ...` both appear in client
    // configs; drop the package name so the parser sees the same argv the CLI
    // process would.
    const start = argv[0] === 'mockingham' ? 1 : argv[0] === '-y' && argv[1] === 'mockingham' ? 2 : 0
    try {
      checkMockinghamArgs(argv.slice(start))
    } catch (error) {
      throw new Error(
        `${file}:${line}: mcpServers.${name} — ${(error as Error).message}`
      )
    }
  }
}
```

Note the `jsonc` case: `checkJsonFence` is called for `json` fences only.
`jsonc` fences are parsed after `//` line comments are stripped — implement
that in Task 4's dispatcher, not here, and only if a guide actually needs a
commented config. Prefer plain `json` and put the commentary in prose.

- [ ] **Step 4: Run and watch them pass**

Run: `node --test test/docs/harness.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add test/docs/fence-checks.ts test/docs/harness.test.ts
```

```sh
git commit -m 'test: per-language fence checks for the docs harness'
```

---

## Task 4: Assembly, execution, and the byte-exact comparison

**Files:**
- Modify: `test/docs/harness.ts`
- Create: `test/docs/fixtures/good.md`, `test/docs/fixtures/mismatch.md`,
  `test/docs/fixtures/throws.md`
- Modify: `test/docs/harness.test.ts` (append)

**Interfaces:**
- Consumes: `Fence`, `extractFences`, `assertKnownFences` from `./harness.ts`;
  all four checks from `./fence-checks.ts`.
- Produces:
  - `assembleProgram(fences: Fence[], entryPath: string): string`
  - `expectedOutput(fences: Fence[]): string`
  - `runDocument(docPath: string): Promise<{ stdout: string; stderr: string; code: number }>`
  - `assertDocument(docPath: string): Promise<void>` — the whole check for one
    file; this is what `docs.test.ts` calls.

- [ ] **Step 1: Write the fixture documents**

Create `test/docs/fixtures/good.md`:

````markdown
# A throwaway document

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'docs' })
console.log(`operations: ${mock.api.operations.length}`)
```

```console
operations: 4
```

And state carries across blocks:

```ts
console.log('second block')
```

```console
second block
```
````

Create `test/docs/fixtures/mismatch.md` — identical to `good.md` except the
first ```console fence reads `operations: 5`.

Create `test/docs/fixtures/throws.md`:

````markdown
```ts
import { createMock } from 'mockingham'
createMock({ openapi: '3.1.0' }, { seed: 'docs' }).nope()
```

```console
never printed
```
````

- [ ] **Step 2: Write the failing tests**

Append to `test/docs/harness.test.ts`:

```ts
import { assembleProgram, expectedOutput, assertDocument } from './harness.ts'

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
```

- [ ] **Step 3: Run and watch them fail**

Run: `node --test test/docs/harness.test.ts`
Expected: FAIL — `assembleProgram` is not exported.

- [ ] **Step 4: Implement assembly and execution**

Append to `test/docs/harness.ts`:

```ts
import { mkdtemp, writeFile, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertPrintableLogs,
  assertBareSpecifier,
  checkShellFence,
  checkJsonFence
} from './fence-checks.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const ENTRY = join(REPO, 'src', 'index.ts')
const EXAMPLE_DOC = join(REPO, 'docs', 'example.json')

export function assembleProgram(fences: Fence[], entryPath: string): string {
  return fences
    .filter((fence) => fence.lang === 'ts')
    .map((fence) => fence.content.replaceAll("'mockingham'", JSON.stringify(entryPath)))
    .join('\n\n')
}

export function expectedOutput(fences: Fence[]): string {
  return fences
    .filter((fence) => fence.lang === 'console')
    .map((fence) => fence.content.replace(/\s+$/, ''))
    .join('\n')
}

function runChild(
  program: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [program],
      { cwd, env: { ...process.env, NO_COLOR: '1' }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr, code })
      }
    )
  })
}

/**
 * Each document runs in its own sandbox holding a copy of the example document
 * named `openapi.json`, with the child's cwd set to it. That is what lets a
 * guide write `readFile('./openapi.json')` — the path a reader actually has —
 * and still resolve here.
 */
export async function runDocument(
  docPath: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const markdown = await readFile(docPath, 'utf8')
  const fences = extractFences(markdown)
  assertKnownFences(fences, docPath)

  for (const fence of fences) {
    if (fence.lang === 'ts') {
      assertPrintableLogs(fence.content, docPath, fence.line)
      assertBareSpecifier(fence.content, docPath, fence.line)
    } else if (fence.lang === 'sh') {
      checkShellFence(fence.content, docPath, fence.line)
    } else if (fence.lang === 'json') {
      checkJsonFence(fence.content, docPath, fence.line)
    } else if (fence.lang === 'jsonc') {
      checkJsonFence(
        fence.content.replace(/^\s*\/\/.*$/gm, ''),
        docPath,
        fence.line
      )
    }
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'mockingham-docs-'))
  await copyFile(EXAMPLE_DOC, join(sandbox, 'openapi.json'))
  const programPath = join(sandbox, 'program.ts')
  await writeFile(programPath, assembleProgram(fences, ENTRY), 'utf8')

  return runChild(programPath, sandbox)
}

export async function assertDocument(docPath: string): Promise<void> {
  const markdown = await readFile(docPath, 'utf8')
  const expected = expectedOutput(extractFences(markdown))
  const result = await runDocument(docPath)

  if (result.code !== 0) {
    throw new Error(
      `${docPath}: the document's program exited ${result.code}\n\n` +
        `--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`
    )
  }

  const actual = result.stdout.replace(/\s+$/, '')
  if (actual !== expected) {
    throw new Error(
      `${docPath}: output does not match the console fences\n\n` +
        `--- expected ---\n${expected}\n\n--- actual ---\n${actual}`
    )
  }
}
```

**Note on the specifier rewrite:** it replaces the literal `'mockingham'`
anywhere in a `ts` block, not only in an import. That is deliberate and blunt —
`assertBareSpecifier` already guarantees imports use it, and a `ts` block has no
other reason to contain that exact quoted string. If a guide ever needs the
literal string `'mockingham'` in code (a seed value, say), use double quotes.

- [ ] **Step 5: Run and watch them pass**

Run: `node --test test/docs/harness.test.ts`
Expected: PASS, 21 tests.

If `good.md` reports a different operation count than 4, do not edit the
assertion until you know why — the count comes from Task 1's document and a
mismatch means one of the two is wrong.

- [ ] **Step 6: Prove the harness can fail — the mutation gate**

This is the step the whole plan rests on. A docs harness that passes against
wrong docs converts "nobody checked" into "the suite says it is fine."

Three mutations, each producing a distinct failure. `mismatch.md` and
`throws.md` already cover two of them and are asserted in Step 2. For the
third, temporarily add a ```python fence to `good.md`:

Run: `node --test test/docs/harness.test.ts`
Expected: FAIL naming `python`. Then remove the fence and re-run to green.

Record in the ledger that all three failure modes were observed, with the
messages.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add test/docs/harness.ts test/docs/harness.test.ts test/docs/fixtures
```

```sh
git commit -m 'test: assemble, execute, and byte-compare a document'
```

---

## Task 5: The runner, and the first real guide

**Files:**
- Create: `test/docs/docs.test.ts`
- Create: `docs/fixtures.md`

**Interfaces:**
- Consumes: `assertDocument` from `./harness.ts`.
- Produces: `docs.test.ts`, which every later guide is automatically covered by.

The runner and the first guide land together on purpose: a runner over an empty
set of documents is a test that cannot fail, which is the exact shape this repo
has been bitten by before.

- [ ] **Step 1: Write the failing test**

Create `test/docs/docs.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertDocument } from './harness.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** Every document the harness runs. Adding a guide means adding it here. */
const DOCUMENTS = [
  'README.md',
  'docs/fixtures.md',
  'docs/webhooks.md',
  'docs/logging-datadog.md',
  'docs/mcp.md'
] as const

test('every reader-facing markdown file is covered by the harness', async () => {
  const entries = await readdir(join(REPO, 'docs'))
  const guides = entries.filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)
  const covered = new Set<string>(DOCUMENTS)
  const uncovered = guides.filter((path) => !covered.has(path))
  assert.deepEqual(
    uncovered,
    [],
    `these documents have no subtest: ${uncovered.join(', ')}`
  )
})

for (const document of DOCUMENTS) {
  test(`${document} runs and prints what it claims`, async () => {
    await assertDocument(join(REPO, document))
  })
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/docs/docs.test.ts`
Expected: FAIL — `ENOENT` for `README.md` and the four guides. That is correct;
this task only turns `docs/fixtures.md` green. The other four subtests stay red
until their tasks, which is the plan's own progress signal.

- [ ] **Step 3: Write `docs/fixtures.md`**

Cover, in this order (spec §3.4):

1. What a fixture is, and invariant 4 up front: a fixture or LLM miss is never
   an error — it falls through to seeded generation. Cite `CLAUDE.md`
   invariant 4.
2. The four modes: `off`, `bake`, `lazy`, `live`.
3. **Local model first.** A ```sh block with `ollama serve` / `ollama pull`,
   then `mockingham bake ./openapi.json --fixtures ./fixtures --model llama3.3`.
   The default provider is `openai-compatible` against `http://localhost:11434/v1`.
4. A runnable ```ts block that bakes without a model, using
   `createRecordedSource` — this is what actually executes:

```ts
import { createMock, createRecordedSource } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))

const mock = createMock(doc, {
  seed: 'docs',
  llm: {
    mode: 'bake',
    source: createRecordedSource([
      {
        operationId: 'getPayment',
        status: 200,
        value: {
          id: '7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30',
          amount: 42.5,
          currency: 'USD',
          status: 'succeeded',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      }
    ])
  }
})

const summary = await mock.bake()
console.log(JSON.stringify(summary, null, 2))
```

   `BakeSummary` is `{ generated, skipped, failed }` — already checked against
   `src/fixtures/bake.ts`. Explain all three in the prose, because the
   distinction is the guide's real content: `skipped` means never attempted
   (recursive, no JSON body, or over the call budget), while `failed` means
   attempted and not stored. `ContentSource.generate` returns
   `FixtureResult | null` with no reason attached, so a source's refusal is
   indistinguishable from any other miss and lands in `failed`.

5. Commit the fixtures, then serve them: `mockingham ./openapi.json --fixtures ./fixtures`.
6. The staleness warning when the document moves under a fixture, and that it
   is diagnostic only — a stale fixture keeps serving.
7. `scope.byName` / `scope.bySchema`, `persona`, and `budget` — carrying the
   caveat verbatim: **`maxConcurrency` is a per-call batch size, not a
   concurrency bound. Nothing in the bake pipeline runs concurrently.**
8. Anthropic as the hosted alternative, briefly, noting `@anthropic-ai/sdk` is
   an optional peer dependency imported lazily.

- [ ] **Step 4: Run the document and reconcile**

Run: `node --test test/docs/docs.test.ts`

The `docs/fixtures.md` subtest will fail on the ```console fence, because you
wrote what you believed the output would be. **Do not paste the actual output
and move on.** For each difference, decide which side is wrong:

- The belief was wrong → fix the fence *and* check whether the surrounding
  prose made the same wrong claim.
- The code is wrong → this plan changes no source. Record it as a deferred item
  with the evidence, and document the actual behavior.

Record every discrepancy in the ledger either way. These are the findings this
cycle exists to produce.

- [ ] **Step 5: Green the subtest**

Run: `node --test test/docs/docs.test.ts`
Expected: the `docs/fixtures.md` subtest and the coverage test PASS; the four
not-yet-written documents still fail with `ENOENT`.

- [ ] **Step 6: Mutate to prove it**

Change one character inside a ```console fence in `docs/fixtures.md`, run the
test, confirm it fails with both sides shown, then revert.

- [ ] **Step 7: Commit**

```sh
git add test/docs/docs.test.ts docs/fixtures.md
```

```sh
git commit -m 'docs: the fixture workflow guide, and the document runner'
```

---

## Task 6: `docs/webhooks.md`

**Files:**
- Create: `docs/webhooks.md`

**Interfaces:**
- Consumes: `assertDocument`, already wired by Task 5's `DOCUMENTS` list — no
  test file changes.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Confirm the subtest is red for the right reason**

Run: `node --test test/docs/docs.test.ts`
Expected: the `docs/webhooks.md` subtest fails with `ENOENT`.

- [ ] **Step 2: Write the guide**

Cover, in this order (spec §3.5):

1. The two shapes: a callback declared on an operation
   (`paymentSucceeded` on `createPayment`) and a top-level webhook
   (`paymentFailed`). Both are in `docs/example.json`.
2. Configuring a destination with `webhooks: { paymentFailed: { url, secret, headers, retry } }`.
3. What triggers a fire: an `emits` entry in an operation's config, or a manual
   `mock.emit(name, opts)`.
4. **The testing loop, which is the reason to read this guide.** Runnable:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))

const mock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  webhooks: { paymentFailed: { url: 'https://example.test/hooks' } }
})

const delivery = await mock.emit('paymentFailed')
await mock.settled()

console.log(`captured ${mock.deliveries().length}`)
console.log(
  JSON.stringify(
    { webhook: delivery.webhook, url: delivery.url, outcome: delivery.outcome },
    null,
    2
  )
)

mock.clearDeliveries()
console.log(`after clear: ${mock.deliveries().length}`)
```

   `Delivery` is `{ webhook, url?, body, headers, outcome, status?, attempts,
   error? }` — already checked against `src/webhooks/deliver.ts`. Print
   `outcome`, not `status`: under `captureOnly` nothing is sent, so `status` is
   absent by design and a guide printing it would teach the wrong expectation.
   `url` is absent when nothing resolved a destination, which is the
   `unresolved` outcome invariant 6 describes — worth its own short example.

5. Signing: what `secret` produces on the wire, and how a receiver verifies it.
6. Invariant 6, stated plainly and cited: emission never affects the response.
   A throw in an emit override, in signing, or in delivery reaches `onError` and
   never the caller; an emit that resolves no destination is captured as
   `unresolved`, not an error.
7. The known limitation: `reset()` does not clear pending emission timers while
   `close()` does, so `settled()` after a `reset()` waits out the full
   `afterMs`. Cite deferred item 25.

- [ ] **Step 3: Run and reconcile**

Run: `node --test test/docs/docs.test.ts`
Apply the same rule as Task 5 Step 4: every difference is a decision, not a
paste. Record discrepancies in the ledger.

- [ ] **Step 4: Mutate to prove it**

One character in a ```console fence, run, confirm failure, revert.

- [ ] **Step 5: Commit**

```sh
git add docs/webhooks.md
```

```sh
git commit -m 'docs: the webhook testing guide'
```

---

## Task 7: `docs/logging-datadog.md`

**Files:**
- Create: `docs/logging-datadog.md`

**Interfaces:**
- Consumes: `assertDocument`, already wired.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Confirm the subtest is red for the right reason**

Run: `node --test test/docs/docs.test.ts`
Expected: `docs/logging-datadog.md` fails with `ENOENT`.

- [ ] **Step 2: Write the guide**

Cover, in this order (spec §3.3):

1. The `LogRecord` field table, taken from `src/runtime/logging.ts` — `ts`,
   `durationMs`, `requestId`, `method`, `route`, `path`, `status`, `bytesIn`,
   `bytesOut`, `params`, `query`, `seed`, `operationId`, `decisions`, `error`,
   `custom`.
2. **The cardinality rule, given its own section because it is the reason this
   recipe exists:** `route` is the templated path and is safe as a tag; `path`
   is resolved, high-cardinality, and must never be one. `'<unmatched>'` is
   `route`'s value when no route matched.
3. The batching sink, runnable against an injected `fetch`, with a fixed clock
   so the timestamps are stable:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))

const sent: string[] = []
const fakeFetch: typeof fetch = async (input, init) => {
  sent.push(JSON.stringify({ url: String(input), body: init?.body }, null, 2))
  return new Response(null, { status: 202 })
}

const batch: unknown[] = []

const mock = createMock(doc, {
  seed: 'docs',
  now: () => 1_767_225_600_000,
  fetch: fakeFetch,
  onLog: (record) => {
    batch.push({
      ddsource: 'mockingham',
      service: 'payments-mock',
      ddtags: `route:${record.route},status:${record.status}`,
      message: `${record.method} ${record.route} ${record.status}`,
      duration_ms: record.durationMs,
      request_id: record.requestId
    })
  },
  onError: (error) => {
    console.log(`sink failure, never reaches the response: ${String(error)}`)
  }
})

await mock.fetch(new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30'))
console.log(JSON.stringify(batch, null, 2))
```

   Then the flush function that posts the batch to
   `https://http-intake.logs.datadoghq.com/api/v2/logs` with a `DD-API-KEY`
   header, called explicitly so its request is printed and asserted.

   The 401 that the bearer-protected `getPayment` returns without credentials is
   itself a good log record to show — a short-circuited response is logged, and
   that is exactly the record an operator most wants. If you would rather show a
   200, supply the `Authorization` header.

4. `ctx.log` for custom fields, landing in `record.custom`.
5. Flush on size, on an interval, and on close, with the note that `onLog`
   returning a promise is awaited but that a slow sink must not be allowed to
   hold a response.

- [ ] **Step 3: Run and reconcile**

Run: `node --test test/docs/docs.test.ts`
Same rule as before: every difference is a decision. In particular, verify that
`now` really does fix the log `ts` — if a timestamp still moves between runs,
that is a finding, and the block must not ship until it is deterministic
(spec §2.4).

- [ ] **Step 4: Mutate to prove it**

One character in a ```console fence, run, confirm failure, revert.

- [ ] **Step 5: Commit**

```sh
git add docs/logging-datadog.md
```

```sh
git commit -m 'docs: the Datadog logging recipe'
```

---

## Task 8: `docs/mcp.md`

**Files:**
- Create: `docs/mcp.md`

**Interfaces:**
- Consumes: `assertDocument`, already wired.
- Produces: nothing later tasks consume.

- [ ] **Step 1: Confirm the subtest is red for the right reason**

Run: `node --test test/docs/docs.test.ts`
Expected: `docs/mcp.md` fails with `ENOENT`.

- [ ] **Step 2: Write the guide**

Cover, in this order (spec §3.6):

1. What the MCP server is over: every tool is a thin adapter over a `Mock`
   method that already exists. `@modelcontextprotocol/sdk` is an optional peer
   dependency; without it the server throws a message telling you to install it.
2. **stdio**, with a ```sh block: `mockingham mcp ./openapi.json`.
3. **http**, runnable — mounted on the mock's own fetch surface, which works
   before or after `listen()`:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'docs' })
const server = mock.mcp({ transport: 'http', path: '/mcp' })

console.log(`mounted at ${server.path}`)
await server.close()
```

4. The twelve shipped tools, one line each: `list_operations`,
   `describe_operation`, `search_operations`, `sample_response`,
   `get_auth_requirements`, `list_webhooks`, `list_deliveries`, `fail_next`,
   `outage`, `emit_webhook`, `set_seed`, `reset`.
5. The ready-to-paste client config, in a ```json fence so the harness parses it
   and runs its flags through `parseMcpArgs`:

```json
{
  "mcpServers": {
    "mockingham": {
      "command": "npx",
      "args": ["mockingham", "mcp", "./openapi.json", "--write"]
    }
  }
}
```

6. **The three things a user otherwise learns the hard way**, each with its
   reason, not just its fact:
   - `--write` gates the five write tools; they change runtime state, so they
     are off by default.
   - With the gate closed those five names **still appear in `tools/list`** with
     a `Disabled.` description. Hiding them and naming the enabling flag in the
     refusal cannot both happen; the flag is the more useful half.
   - `sample_response` **is** `mock.fetch`. It returns 401 on an auth-protected
     operation unless the caller supplies credentials. An auth shortcut would
     recreate the second code path the no-drift design exists to prevent.
7. `set_override`, `clear_overrides`, and `regenerate_fixture` named as not yet
   existing, with a one-line pointer to the runtime-override cycle. Do not imply
   a date.

- [ ] **Step 3: Run and reconcile**

Run: `node --test test/docs/docs.test.ts`
Same rule. Note that `mcp()` needs the SDK installed — it is a devDependency
here, so it resolves in this repo. If the block fails on a missing SDK, that is
a finding about how the guide must be written, not a reason to change `src/`.

- [ ] **Step 4: Prove the client config is really checked**

Change `--write` to `--writes` inside the ```json fence, run the test, confirm
it fails naming the unknown option, then revert. This is the one fence whose
check is easiest to believe without evidence.

- [ ] **Step 5: Commit**

```sh
git add docs/mcp.md
```

```sh
git commit -m 'docs: the MCP setup guide'
```

---

## Task 9: `README.md`

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: `assertDocument`, already wired; links to all four guides.
- Produces: the repo's public front door.

- [ ] **Step 1: Confirm the subtest is red for the right reason**

Run: `node --test test/docs/docs.test.ts`
Expected: `README.md` fails with `ENOENT`. Every other subtest is green by now.

- [ ] **Step 2: Write the README**

In this order (spec §3.2):

1. **What it is.** An OpenAPI-driven HTTP mock server: point it at a document,
   get a server that answers every declared operation with schema-valid,
   deterministic data.
2. **Why not Prism, MSW, or WireMock.** Be specific and fair — determinism as a
   guarantee rather than a happy accident, one schema interpretation shared by
   generation and validation, errors that stay on the operation's declared
   error schema, and a control plane designed to be driven by a machine.
3. **Requirements and install.** Node >= 24.2.0. State the no-build-step choice
   and its reason near the top — the published package is TypeScript source,
   stripped by Node itself, so the code you debug is the code that shipped.
   `zod` is the only runtime dependency; the Anthropic and MCP SDKs are optional
   peers imported lazily.
4. **A 60-second quickstart**, self-contained so it survives copy-paste:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'quickstart' })

const response = await mock.fetch(
  new Request('http://mock/payments', {
    headers: { authorization: 'Bearer test-token' }
  })
)

console.log(`status ${response.status}`)
console.log(JSON.stringify(await response.json(), null, 2))
```

   Plus the CLI equivalent in a ```sh fence.

5. **Determinism, demonstrated rather than asserted:** two mocks on the same
   seed produce the same bytes. Then a sentence pointing at
   `scripts/determinism.ts` and the test that runs it, which is where the
   cross-process claim is actually proven. Do not spawn a subprocess here —
   spec §3.2.
6. **The tour**, one tight section each, every one ending in a link to its
   guide where one exists: generation and determinism; overrides and headers;
   validation and auth; failure simulation; idempotency; webhooks; fixtures and
   LLM content; MCP; logging.
7. **CLI reference** for `mockingham`, `mockingham bake`, and `mockingham mcp`.
   Every flag shown must appear in a ```sh fence or match the real usage text —
   the harness parses the fences, so a renamed flag fails the suite.
8. **Known limitations, up front**, restating master §19 for a public audience,
   corrected to what actually shipped.
9. License (MIT) and a link to the design spec for anyone who wants the
   contract rather than the manual.

**Do not document `Mock.override()`.** It does not exist. Task 10 fixes the
spec that still advertises it.

- [ ] **Step 3: Run and reconcile**

Run: `node --test test/docs/docs.test.ts`
Expected after reconciliation: every subtest green, coverage test green.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: the existing 898 tests plus the new ones, all passing.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add README.md
```

```sh
git commit -m 'docs: README'
```

---

## Task 10: Corrections and the deferred ledger

**Files:**
- Modify: `CLAUDE.md:15`
- Modify: `docs/superpowers/specs/2026-08-11-mockingham-design.md` §1, §19
- Modify: `docs/superpowers/deferred-items.md`

**Interfaces:**
- Consumes: every finding recorded during Tasks 5–9.
- Produces: a ledger entry per finding, each with a ruling.

- [ ] **Step 1: Verify CLAUDE.md's run command now works**

Run: `node src/server/cli.ts docs/example.json --port 4100`
Expected: it serves. Stop it. If it works, `CLAUDE.md:15` needs no edit — the
document it referenced now exists, which was the fix. If the command needs
different wording, correct it.

- [ ] **Step 2: Correct master §1's phantom method**

In `docs/superpowers/specs/2026-08-11-mockingham-design.md`, the instance
surface lists:

```ts
  override(target: string, value: Override): void
```

It has never been implemented. Mark it as deferred to the runtime-override
cycle rather than deleting it — the history of why it was specified matters —
using a comment that makes its status unmistakable to anyone reading the
surface as a contract:

```ts
  // NOT IMPLEMENTED — deferred to the runtime-override cycle. See the phase 10
  // MCP delta section 1 and the phase 12 docs delta section 5.2.
  override(target: string, value: Override): void
```

- [ ] **Step 3: Reconcile master §19's limitations**

Read §19's seven bullets against what shipped. For each, either confirm it or
correct it at the source. Do not silently delete one — if a limitation no longer
holds, say so and name the change that lifted it.

- [ ] **Step 4: Write the ledger entries**

Append to `docs/superpowers/deferred-items.md`, following the existing format,
one entry per finding from Tasks 5–9 plus these two known ones:

- **The missing `exports` map.** The docs tell readers to
  `import { createMock } from 'mockingham'`, which resolves today only because
  `package.json` declares no `exports` map. Deciding what is public is a
  packaging decision with permanent blast radius and it is not a docs decision.
  Ruling: deferred, with this reasoning.
- **Every discrepancy found while reconciling a ```console fence**, with the
  expected output, the actual output, and which side was judged wrong.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Confirm nothing under src/ changed**

Run: `git diff --stat main -- src`
Expected: no output. If there is any, spec §1's hard boundary was crossed —
stop and raise it rather than absorbing it.

- [ ] **Step 8: Commit**

```sh
git add CLAUDE.md docs/superpowers/specs/2026-08-11-mockingham-design.md docs/superpowers/deferred-items.md
```

```sh
git commit -m 'docs: correct the phantom override method and record phase 12 findings'
```

---

## Verification

The plan is done when all of these hold:

1. `npm test` passes — 898 existing tests plus the docs suite.
2. `npx tsc --noEmit` produces no output.
3. `git diff --stat main -- src` produces no output.
4. Each of the three harness failure modes has been observed at least once, with
   the message recorded in the ledger: a wrong ```console fence, an unknown
   fence language, and a bad flag inside the MCP client config.
5. Every document in `docs/*.md` appears in `docs.test.ts`'s `DOCUMENTS` list —
   asserted by the coverage test, not by inspection.
6. Every finding from Tasks 5–9 has a ledger entry with a ruling.
