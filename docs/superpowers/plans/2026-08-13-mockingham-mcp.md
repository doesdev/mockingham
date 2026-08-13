# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the loaded OpenAPI document and the mock's control plane to an
agent as twelve MCP tools, over stdio and over the mock's own HTTP port.

**Architecture:** A pure tool layer (`src/mcp/context.ts`, `src/mcp/tools/*`)
that knows nothing about MCP-the-protocol, plus one adapter
(`src/mcp/server.ts`) that lazily imports `@modelcontextprotocol/sdk`,
registers those tools, and hands each HTTP request to the SDK's Web-standard
transport. `createMock` composes a dispatcher that routes the mount path to the
adapter and everything else to the existing handler.

**Tech Stack:** TypeScript (erasable syntax only), ESM, Node >= 24,
`node:test`, `zod` 4, `@modelcontextprotocol/sdk` 1.30.0 (optional peer
dependency, dev dependency for tests).

**Spec:** `docs/superpowers/specs/2026-08-13-mockingham-mcp-design.md` — read
it. It is the authority; this plan argues from it. Where a task and the spec
disagree, the spec wins and the disagreement is a defect in this plan.

## Global Constraints

Every task's requirements implicitly include all of these.

1. **Erasable syntax only.** No `enum`, no `namespace`, no parameter
   properties. Use `const X = {...} as const`.
2. **Purity.** `src/mcp/context.ts` and `src/mcp/tools/*.ts` must not import
   anything from `node:` and must not import `@modelcontextprotocol/sdk`.
   `src/server/handler.ts` must not import anything from `src/mcp/`.
   Verify with: `grep -rn "node:\|modelcontextprotocol" src/mcp/context.ts src/mcp/tools/`
3. **`zod` is the only hard runtime dependency.** The SDK is imported lazily,
   with `await import(...)`, inside the function that needs it — never at module
   top level.
4. **Determinism.** No `Math.random()`, no `Date.now()`, no iteration over an
   unordered `Set` or object in anything that reaches output. Randomness comes
   from `createRng` in `src/generate/rng.ts`.
5. **A fixture or LLM miss is never an error** (invariant 4). **Errors stay
   on-contract** (invariant 5). **Emission never affects the response**
   (invariant 6). Nothing in this plan may weaken these.
6. **US English spelling** everywhere — identifiers, test names, comments,
   docs. `honor`, `behavior`, `serialize`, `normalize`, `canceled`.
7. **Tests live in `test/` mirroring `src/`**, written in TypeScript, run by
   `node:test`. Write the test first, watch it fail, then implement.
8. **Shell:** one plain command per Bash call, literal arguments, absolute
   paths, no `&&`/`||`/`;`/`|`/`$(...)`/`>`/heredocs, never `cd`. Use the
   Write/Edit tools instead of shell redirection. Multi-paragraph commits use
   repeated `-m`.
9. **`git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy.**
   If you think you need one, stop and ask.

### Verify every mutation before you trust a test

This project's recurring defect is a test that cannot fail. Every task below
names a **mutation**: a specific edit to production code that must break the
test you just wrote.

**The prescribed mutation may itself be wrong or stale — validate it.** Apply
it, run the test, and confirm it fails for the reason stated. If the test still
passes, the test is vacuous: fix the test, not the mutation. Then revert the
mutation and confirm green. On the last plan this caught eight vacuous or
mis-specified tests, five of them found by the implementers themselves.

### Commands

```sh
npm test                      # whole suite
node --test test/mcp/         # this plan's tests
npx tsc --noEmit              # typecheck
```

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/mcp/context.ts` | `McpContext`, `McpTool`, `computeEmitters` — the pure contract tools are written against |
| `src/mcp/tools/read.ts` | the seven read tools |
| `src/mcp/tools/write.ts` | the five write tools |
| `src/mcp/tools/index.ts` | assembles the tool list, applies the write gate |
| `src/mcp/server.ts` | lazy SDK import, tool registration, per-request transport, stdio |
| `src/schema/json-schema.ts` | `toJsonSchema(schema, compiler)` — the single Schema→JSON Schema derivation |
| `test/mcp/doc.ts` | the test document: tags, security, a callback, a webhook |
| `test/mcp/*.test.ts` | one file per task |

**Modified:** `src/spec/types.ts`, `src/spec/load.ts`, `src/fixtures/source.ts`,
`src/index.ts`, `src/server/cli.ts`, `package.json`.

### Task order, and why task 3 is where it is

Task 3 mounts the server and gets one tool answering a real JSON-RPC request
through `mock.fetch()` — before nine of the twelve tools exist. That is
deliberate. Plan 7's two worst defects were seams where each side was
individually correct and disagreed with the other, and nine tasks of per-task
review saw neither; both surfaced the moment someone tested through the public
surface. Task 3 is that test, and it lands third.

---

## Task 1: `tags` on `Operation`

Design amendment 3.1. `list_operations` filters by tag and `search_operations`
searches tags, but `Operation` has no `tags` field and `load.ts` never reads
one.

**Files:**
- Modify: `src/spec/types.ts` (the `Operation` interface, around line 99)
- Modify: `src/spec/load.ts` (the `operations.push({...})` call, around line 122)
- Test: `test/spec/load.test.ts` (append)

**Interfaces:**
- Produces: `Operation.tags: string[]` — always present, `[]` when the document
  declares none. Every later task reads it.

- [ ] **Step 1: Write the failing test**

Append to `test/spec/load.test.ts`:

```ts
test('loads operation tags, defaulting to an empty array', () => {
  const api = loadApi({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: { operationId: 'a', tags: ['pets', 'admin'], responses: {} } },
      '/b': { get: { operationId: 'b', responses: {} } }
    }
  })

  const a = api.operations.find((op) => op.operationId === 'a')
  const b = api.operations.find((op) => op.operationId === 'b')
  assert.deepEqual(a?.tags, ['pets', 'admin'])
  assert.deepEqual(b?.tags, [])
})

test('drops non-string tags rather than coercing them', () => {
  const api = loadApi({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/a': { get: { operationId: 'a', tags: ['ok', 7, null, { x: 1 }], responses: {} } }
    }
  })

  assert.deepEqual(api.operations[0]?.tags, ['ok'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/spec/load.test.ts`
Expected: FAIL — `tags` is `undefined`, so `deepEqual` reports
`undefined !== ['pets','admin']`.

- [ ] **Step 3: Add the field to the type**

In `src/spec/types.ts`, inside `interface Operation`, after `description`:

```ts
  /** Free-form OpenAPI tags. Always present; `[]` when the document declares none. */
  tags: string[]
```

- [ ] **Step 4: Load it**

In `src/spec/load.ts`, inside the `operations.push({...})` object literal, after
the `description` line:

```ts
        // Non-strings are dropped rather than coerced — same treatment every
        // other array in this loader gives a malformed entry. A tag is a
        // filter key; a coerced "7" would match nothing and look like a bug.
        tags: Array.isArray(op['tags'])
          ? (op['tags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string')
          : [],
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/spec/load.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the mutation**

Change the `tags:` line to `tags: [],` unconditionally. Re-run — the first test
must fail on `['pets','admin']`. Then change it to the `Array.isArray(...)`
form without the `.filter(...)` — the second test must fail with `7` present.
Revert both.

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npx tsc --noEmit`
Run: `npm test`
Expected: both clean. `tags` is required, so any other place constructing an
`Operation` literal will fail to typecheck — fix those by adding `tags: []`.

- [ ] **Step 8: Commit**

```sh
git add src/spec/types.ts src/spec/load.ts test/spec/load.test.ts
git commit -m 'feat: load operation tags' -m 'Design amendment 3.1: list_operations filters by tag and search_operations searches them, but Operation never carried the field.'
```

---

## Task 2: `McpContext`, the tool contract, and `list_operations`

The pure foundation. No SDK, no protocol, no Node.

**Files:**
- Create: `src/mcp/context.ts`
- Create: `src/mcp/tools/read.ts`
- Create: `src/mcp/tools/index.ts`
- Create: `test/mcp/doc.ts`
- Test: `test/mcp/tools-read.test.ts`

**Interfaces:**
- Consumes: `Operation.tags` from Task 1.
- Produces: `McpContext`, `McpTool`, `computeEmitters`, `READ_TOOLS`,
  `mcpTools(options)`. Task 3 registers what `mcpTools` returns; tasks 4–7 add
  entries to `READ_TOOLS` / `WRITE_TOOLS`.

- [ ] **Step 1: Write the test document**

Create `test/mcp/doc.ts`. This document is reused by every later task in this
plan, so it carries tags, two security schemes, a callback, and a top-level
webhook even though task 2 only reads tags.

```ts
export const mcpDoc = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  security: [{ bearerAuth: [] }],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        summary: 'List all orders',
        description: 'Returns every order the caller can see.',
        tags: ['orders', 'read'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
        ],
        responses: {
          '200': {
            description: 'Orders',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createOrder',
        summary: 'Place an order',
        tags: ['orders', 'write'],
        security: [{ apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Order' } }
          }
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } }
            }
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } }
                }
              }
            }
          }
        },
        callbacks: {
          orderShipped: {
            '{$request.body#/callbackUrl}': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { orderId: { type: 'string' } }
                      }
                    }
                  }
                },
                responses: { '204': { description: 'ack' } }
              }
            }
          }
        }
      }
    },
    '/orders/{orderId}': {
      get: {
        operationId: 'getOrder',
        summary: 'Fetch one order',
        tags: ['orders', 'read'],
        parameters: [
          {
            name: 'orderId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 3 }
          }
        ],
        responses: {
          '200': {
            description: 'One order',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } }
            }
          }
        }
      }
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe',
        tags: ['ops'],
        security: [],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
              }
            }
          }
        }
      }
    }
  },
  webhooks: {
    orderCreated: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' }, total: { type: 'number' } }
              }
            }
          }
        },
        responses: { '204': { description: 'ack' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    },
    schemas: {
      Order: {
        type: 'object',
        required: ['id', 'total'],
        properties: {
          id: { type: 'string' },
          total: { type: 'number' },
          note: { type: 'string' }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Write the shared test helpers**

Create `test/mcp/helpers.ts`. Every later task in this plan imports from here;
creating it now rather than extracting it later avoids three tasks each
inventing their own copy.

```ts
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'
import type { Mock, MockOptions } from '../../src/index.ts'
import { mcpTools } from '../../src/mcp/tools/index.ts'
import type { McpToolOptions } from '../../src/mcp/tools/index.ts'
import { computeEmitters } from '../../src/mcp/context.ts'
import type { McpContext, McpTool } from '../../src/mcp/context.ts'
import { compileConfigs } from '../../src/runtime/config.ts'
import { mcpDoc } from './doc.ts'

/**
 * Builds the same McpContext `createMock` builds, from an existing Mock.
 * These two constructions MUST stay in step — see self-review note 1 at the
 * end of the plan. If you were able to have createMock export the context it
 * builds, delete this body and call that instead.
 */
export function contextForMock(mock: Mock, options: MockOptions = {}): McpContext {
  return {
    api: mock.api,
    fetch: (request) => mock.fetch(request),
    failNext: (target, opts) => mock.failNext(target, opts),
    outage: (target, opts) => mock.outage(target, opts),
    setSeed: (seed) => mock.setSeed(seed),
    reset: () => mock.reset(),
    emit: (name, opts) => mock.emit(name, opts),
    deliveries: () => mock.deliveries(),
    emitters: computeEmitters(
      mock.api.operations,
      compileConfigs(options.operations, mock.api.operations)
    ),
    origin: 'http://mock.local'
  }
}

export function contextFor(
  doc: Record<string, unknown> = mcpDoc,
  options: MockOptions = {}
): McpContext {
  return contextForMock(createMock(doc, options), options)
}

export function toolNamed(name: string, options: McpToolOptions = {}): McpTool {
  const tool = mcpTools(options).find((candidate) => candidate.name === name)
  assert.ok(tool, `no tool named ${name}`)
  return tool
}
```

`contextForMock` takes the same `options` the `Mock` was built with, because
`emitters` is derived from `options.operations` and there is no way to recover
it from a constructed `Mock`. Callers that pass `operations` config must pass
it here too — Task 6's configured-emitters test depends on that.

- [ ] **Step 3: Write the failing test**

Create `test/mcp/tools-read.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFor, toolNamed } from './helpers.ts'

test('list_operations returns every operation in document order', async () => {
  const result = (await toolNamed('list_operations').handler(contextFor(), {})) as
    Array<{ method: string; path: string; operationId?: string; tags: string[] }>

  assert.deepEqual(
    result.map((entry) => `${entry.method} ${entry.path}`),
    ['GET /orders', 'POST /orders', 'GET /orders/{orderId}', 'GET /health']
  )
  assert.deepEqual(result[0]?.tags, ['orders', 'read'])
  assert.equal(result[0]?.summary, 'List all orders')
})

test('list_operations filters by tag', async () => {
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { tag: 'write' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(result.map((entry) => entry.operationId), ['createOrder'])
})

test('list_operations filters by path prefix', async () => {
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { pathPrefix: '/orders' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(
    result.map((entry) => entry.operationId),
    ['listOrders', 'createOrder', 'getOrder']
  )
})

test('list_operations applies tag and prefix together', async () => {
  const result = (await toolNamed('list_operations').handler(
    contextFor(), { tag: 'read', pathPrefix: '/orders/' }
  )) as Array<{ operationId?: string }>

  assert.deepEqual(result.map((entry) => entry.operationId), ['getOrder'])
})
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --test test/mcp/tools-read.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp/tools/index.ts'`.

- [ ] **Step 5: Write `src/mcp/context.ts`**

```ts
import type { Api, Operation } from '../spec/types.ts'
import type { ZodType } from 'zod'
import type { Delivery } from '../webhooks/deliver.ts'
import type { EmitOptions } from '../server/handler.ts'
import type { CompiledConfig } from '../runtime/config.ts'

export interface McpFailNextOptions {
  times?: number
  status?: number
}

export interface McpOutageOptions {
  forMs?: number
  status?: number
}

/**
 * What a tool is allowed to reach. Deliberately narrower than `Mock`: a tool
 * that can reach `close()` is a tool that can be made to close the mock, and a
 * narrow interface is one a test can build by hand. Options types are declared
 * here rather than imported from `../index.ts` — that module imports this one.
 */
export interface McpContext {
  api: Api
  fetch(request: Request): Promise<Response>
  failNext(target: string, opts?: McpFailNextOptions): Promise<void>
  outage(target: string, opts?: McpOutageOptions): Promise<void>
  setSeed(seed: string): Promise<void>
  reset(): Promise<void>
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
  /** Webhook name → the operation targets configured to emit it. See design §3.6. */
  emitters: Map<string, string[]>
  /**
   * Origin for the synthetic Requests `sample_response` builds. Route matching
   * uses only the pathname, so this never affects which operation is selected;
   * it exists because `new Request(url)` demands an absolute URL.
   */
  origin: string
}

export interface McpTool {
  name: string
  description: string
  /** A zod raw shape — the SDK's `registerTool` takes exactly this. */
  inputSchema: Record<string, ZodType>
  handler(ctx: McpContext, args: Record<string, unknown>): Promise<unknown> | unknown
}

/**
 * Which operations are configured to emit which webhook (design §3.6). A
 * top-level `webhooks` entry carries no declared emitter — the linkage lives
 * in mockingham's own operation config, which is why this is computed from the
 * compiled configs rather than from the document.
 */
export function computeEmitters(
  operations: Operation[],
  configs: CompiledConfig[]
): Map<string, string[]> {
  const emitters = new Map<string, string[]>()
  for (const operation of operations) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`
    for (const compiled of configs) {
      if (!compiled.matches(operation)) continue
      for (const emit of compiled.config.emits ?? []) {
        const existing = emitters.get(emit.webhook)
        if (existing === undefined) emitters.set(emit.webhook, [label])
        else if (!existing.includes(label)) existing.push(label)
      }
    }
  }
  return emitters
}
```

- [ ] **Step 6: Write `src/mcp/tools/read.ts`**

```ts
import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'

const listOperations: McpTool = {
  name: 'list_operations',
  description:
    'List the operations this mock serves: method, path, operationId, summary, ' +
    'and tags. Filter with `tag` or `pathPrefix`. Start here, then call ' +
    'describe_operation for the one you are working on.',
  inputSchema: {
    tag: z.string().optional().describe('Only operations carrying this exact tag'),
    pathPrefix: z.string().optional().describe('Only operations whose path starts with this')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const tag = args.tag as string | undefined
    const pathPrefix = args.pathPrefix as string | undefined
    // Document order, which loadApi preserves. Deterministic without sorting,
    // and it keeps related operations adjacent the way the author wrote them.
    return ctx.api.operations
      .filter((operation) => tag === undefined || operation.tags.includes(tag))
      .filter((operation) => pathPrefix === undefined || operation.path.startsWith(pathPrefix))
      .map((operation) => ({
        method: operation.method.toUpperCase(),
        path: operation.path,
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags
      }))
  }
}

export const READ_TOOLS: McpTool[] = [listOperations]
```

- [ ] **Step 7: Write `src/mcp/tools/index.ts`**

```ts
import type { McpTool } from '../context.ts'
import { READ_TOOLS } from './read.ts'

export interface McpToolOptions {
  /** Expose the write tools. Default false — design §3.7. */
  write?: boolean
}

/**
 * The tool list for one server. The write gate lives here so that both halves
 * of it — what `tools/list` advertises and what `tools/call` will accept — come
 * from one decision. A gate that only hid the tools from the listing would not
 * be a gate.
 */
export function mcpTools(options: McpToolOptions = {}): McpTool[] {
  // WRITE_TOOLS arrives in task 7; until then `write` selects nothing extra.
  return options.write === true ? [...READ_TOOLS] : [...READ_TOOLS]
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test test/mcp/tools-read.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Verify the mutation**

In `read.ts`, delete the `pathPrefix` filter line. Re-run — the prefix test and
the combined test must both fail. Then restore it and change
`operation.tags.includes(tag)` to `true` — the tag test and combined test must
fail. Revert both.

- [ ] **Step 10: Verify purity**

Run: `grep -rn 'node:\|modelcontextprotocol' /opt/claude-projects/mockingham/src/mcp/`
Expected: no matches. If there are any, you have broken Global Constraint 2.

- [ ] **Step 11: Typecheck, full suite, commit**

Run: `npx tsc --noEmit`
Run: `npm test`

```sh
git add src/mcp test/mcp
git commit -m 'feat: MCP tool contract and list_operations' -m 'The pure half: McpContext is what a tool may reach, deliberately narrower than Mock. No SDK and no node: imports below src/mcp/server.ts.'
```

---

## Task 3: Mount it — `server.ts`, `Mock.mcp()`, and the end-to-end test

The seam task. After this, a real JSON-RPC request reaches a real tool through
`mock.fetch()`.

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Modify: `package.json`
- Test: `test/mcp/mount.test.ts`

**Interfaces:**
- Consumes: `mcpTools()`, `McpContext`, `computeEmitters` from Task 2.
- Produces: `createMcpServer(context, options): McpServerHandle`,
  `Mock.mcp(options): McpServerHandle`. Task 7 passes `write` through; Task 8
  calls `connectStdio()`.

**Facts verified against SDK 1.30.0 — do not re-litigate these, but do re-run
the probe if you suspect a version difference:**

- `WebStandardStreamableHTTPServerTransport.handleRequest(req: Request): Promise<Response>`
  is the whole HTTP surface.
- In stateless mode (`sessionIdGenerator: undefined`) the transport **throws on
  a second `handleRequest`**, so a fresh `McpServer` + transport per request is
  required, not optional.
- A stateless transport answers `tools/list` and `tools/call` **with no prior
  `initialize`**, returning 200 and `content-type: application/json` when
  `enableJsonResponse: true`.
- Closing the transport and server **before** reading the response body does
  not truncate it.
- A tool callback that throws is already converted by the SDK into
  `{ isError: true, content: [{ type: 'text', text: <message> }] }`. **Do not
  add your own try/catch around the handler** — it would duplicate this and
  swallow the distinction.

- [ ] **Step 1: Add the dependencies to `package.json`**

Add, as siblings of `dependencies`:

```json
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.30.0",
    "@modelcontextprotocol/sdk": ">=1.30.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true },
    "@modelcontextprotocol/sdk": { "optional": true }
  },
```

`@modelcontextprotocol/sdk` is already in `devDependencies` at `^1.30.0`. Do
not remove it — the tests need it (design §4). This also closes plan 7's gap:
`@anthropic-ai/sdk` was documented as an optional peer dependency and declared
nowhere.

- [ ] **Step 2: Write the failing test**

Create `test/mcp/mount.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/mcp/mount.test.ts`
Expected: FAIL — `mock.mcp is not a function`.

- [ ] **Step 4: Write `src/mcp/server.ts`**

```ts
import type { McpContext, McpTool } from './context.ts'
import { mcpTools } from './tools/index.ts'

export interface McpOptions {
  /**
   * `http` mounts on the mock's own port; `stdio` connects immediately;
   * `inline` attaches nothing, which is what a test wants. Default `inline`.
   */
  transport?: 'http' | 'stdio' | 'inline'
  /** http only. Default `/mcp`. */
  path?: string
  /** Expose the five write tools. Default false — design §3.7. */
  write?: boolean
}

export interface McpServerHandle {
  /** Present only for transport `http`. */
  path?: string
  /** Serves over stdio. Node-only. */
  connectStdio(): Promise<void>
  close(): Promise<void>
  /** Handles one HTTP request. Fresh server and transport per call — see below. */
  handleRequest(request: Request): Promise<Response>
}

const MISSING_SDK =
  'mockingham: the MCP server needs @modelcontextprotocol/sdk, which is an ' +
  'optional peer dependency. Install it with:\n\n' +
  '  npm install @modelcontextprotocol/sdk\n'

/**
 * Lazily imported so the package keeps zod as its only hard runtime
 * dependency. Only a genuinely absent module becomes the friendly message — an
 * error thrown from inside the SDK propagates as itself, because reporting a
 * broken install as a missing one sends the reader to the wrong problem.
 */
async function loadSdk(): Promise<{
  McpServer: new (info: { name: string; version: string }) => McpServerLike
  WebStandardStreamableHTTPServerTransport: new (options: {
    sessionIdGenerator: undefined
    enableJsonResponse: boolean
  }) => TransportLike
}> {
  try {
    const [mcp, http] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
    ])
    return {
      McpServer: mcp.McpServer as never,
      WebStandardStreamableHTTPServerTransport:
        http.WebStandardStreamableHTTPServerTransport as never
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(MISSING_SDK)
    }
    throw error
  }
}

interface McpServerLike {
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: Record<string, unknown> },
    cb: (args: Record<string, unknown>) => Promise<unknown>
  ): unknown
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

interface TransportLike {
  handleRequest(request: Request): Promise<Response>
  close(): Promise<void>
}

function register(server: McpServerLike, context: McpContext, tools: McpTool[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        // No try/catch: the SDK already converts a throw into
        // { isError: true, content: [...] } with the message intact, which is
        // exactly what a mistyped control-plane target should produce.
        const result = await tool.handler(context, args ?? {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      }
    )
  }
}

export function createMcpServer(
  context: McpContext,
  options: McpOptions = {},
  version = '0.0.0'
): McpServerHandle {
  const tools = mcpTools({ write: options.write })
  let stdio: { server: McpServerLike; close(): Promise<void> } | undefined

  return {
    path: options.transport === 'http' ? (options.path ?? '/mcp') : undefined,

    async handleRequest(request: Request): Promise<Response> {
      const sdk = await loadSdk()
      // A fresh server and transport per request. This is required, not
      // defensive: a stateless transport throws on its second handleRequest,
      // because reuse collides message ids between clients. Our tools hold no
      // state — everything they touch lives on the Mock — so there is nothing
      // a session would remember. Registering twelve tools costs microseconds.
      const transport = new sdk.WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      const server = new sdk.McpServer({ name: 'mockingham', version })
      register(server, context, tools)
      await server.connect(transport)
      try {
        return await transport.handleRequest(request)
      } finally {
        // Verified safe: the response body survives this. Without it, every
        // request would leave a server and transport for the collector.
        await transport.close()
        await server.close()
      }
    },

    async connectStdio(): Promise<void> {
      const sdk = await loadSdk()
      const { StdioServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/stdio.js'
      )
      const server = new sdk.McpServer({ name: 'mockingham', version })
      register(server, context, tools)
      const transport = new StdioServerTransport()
      await server.connect(transport)
      stdio = { server, close: () => server.close() }
    },

    async close(): Promise<void> {
      await stdio?.close()
      stdio = undefined
    }
  }
}
```

- [ ] **Step 5: Wire it into `src/index.ts`**

Add the imports:

```ts
import { createMcpServer } from './mcp/server.ts'
import type { McpOptions, McpServerHandle } from './mcp/server.ts'
import { computeEmitters } from './mcp/context.ts'
import type { McpContext } from './mcp/context.ts'
import { compileConfigs } from './runtime/config.ts'
```

Add to the `Mock` interface:

```ts
  /**
   * Builds an MCP server over this mock. `transport: 'http'` mounts it on the
   * mock's own fetch surface, so it works before or after `listen()`.
   */
  mcp(options?: McpOptions): McpServerHandle
```

Inside `createMock`, after `const handler = createHandler(...)` and before
`const server = createNodeServer(...)`:

```ts
  // Read on every request rather than captured, so mcp() works after listen().
  let mount: { path: string; handle: McpServerHandle } | undefined

  const fetchWithMcp = async (request: Request): Promise<Response> => {
    const current = mount
    if (current !== undefined && new URL(request.url).pathname === current.path) {
      return current.handle.handleRequest(request)
    }
    return handler.fetch(request)
  }

  const server = createNodeServer(fetchWithMcp)
```

(Replace the existing `const server = createNodeServer(handler.fetch)`.)

Then in the returned object, replace `fetch: handler.fetch,` with
`fetch: fetchWithMcp,` and add the `mcp` method:

```ts
    mcp(mcpOptions: McpOptions = {}): McpServerHandle {
      const context: McpContext = {
        api,
        fetch: fetchWithMcp,
        failNext: (target, opts) => mockRef.failNext(target, opts),
        outage: (target, opts) => mockRef.outage(target, opts),
        setSeed: (seed) => mockRef.setSeed(seed),
        reset: () => mockRef.reset(),
        emit: (name, opts) => handler.emit(name, opts),
        deliveries: () => handler.deliveries(),
        emitters: computeEmitters(api.operations, compileConfigs(options.operations, api.operations)),
        origin: 'http://mock.local'
      }
      const handle = createMcpServer(context, mcpOptions)

      if (mcpOptions.transport === 'http') {
        const path = mcpOptions.path ?? '/mcp'
        if (api.operations.some((operation) => operation.path === path)) {
          ;(options.onWarn ?? ((message: string) => console.warn(message)))(
            `mockingham: the MCP server is mounted at ${path}, which shadows an ` +
              'operation the document declares at the same path. Requests to it ' +
              'will reach the MCP server, not the mock. Mount elsewhere with ' +
              'mcp({ path: "..." }) if that is not what you want.'
          )
        }
        mount = { path, handle }
      }

      return handle
    },
```

`mockRef` is the object `createMock` returns. Today `createMock` ends with a
bare `return { ... }`; change that to bind it first, so `mcp()` can reach the
control-plane methods through the same surface a user would rather than
duplicating their key logic:

```ts
  const mockRef: Mock = {
    fetch: fetchWithMcp,
    // ...every existing member, unchanged...
    mcp(mcpOptions: McpOptions = {}): McpServerHandle { /* as above */ }
  }

  return mockRef
```

`mcp` is defined inside the same literal and refers to `mockRef` only when
called, never during construction, so the self-reference is safe.

`context.fetch` is `fetchWithMcp`, not `handler.fetch` — `sample_response` must
see the mock exactly as a client does.

- [ ] **Step 6: Export the new types**

At the bottom of `src/index.ts`, beside the other type re-exports:

```ts
export type { McpOptions, McpServerHandle } from './mcp/server.ts'
export type { McpContext, McpTool } from './mcp/context.ts'
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/mcp/mount.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Verify the mutations**

Three separate mutations, each targeting a different test:

1. In `index.ts`, change `fetch: fetchWithMcp,` back to `fetch: handler.fetch,`.
   The first four tests must fail (the mount is unreachable through
   `mock.fetch`). Revert.
2. In `server.ts`, hoist the transport and server out of `handleRequest` into
   `createMcpServer` so they are built once. The "each request is independent"
   test must fail with *"Stateless transport cannot be reused across
   requests"*. Revert.
3. In `index.ts`, delete the shadow-warning block. The last test must fail.
   Revert.

If mutation 2 does not produce that error, the SDK version has changed
behavior — stop and re-run `.superpowers/probe/probe-mcp.ts` before continuing.

- [ ] **Step 9: Confirm the suite still exits**

Run: `npm test`
Expected: clean, **and the process exits on its own**. If `node --test` hangs
at the end, a per-request transport has started leaving a timer behind and the
stateless/JSON assumption in design §3.4 no longer holds. That is a blocker,
not a nuisance — report it.

- [ ] **Step 10: Typecheck and commit**

Run: `npx tsc --noEmit`

```sh
git add src/mcp/server.ts src/index.ts package.json test/mcp/mount.test.ts
git commit -m 'feat: mount the MCP server on the mock fetch surface' -m 'A fresh McpServer and transport per request: the SDK stateless transport throws on reuse, and our tools hold no state worth a session.' -m 'The mount slot is read per request rather than captured, so mcp() works after listen(). A document operation at the mount path is shadowed with a warning rather than silently.'
```

---

## Task 4: `describe_operation`, `get_auth_requirements`, and one JSON Schema derivation

**Files:**
- Create: `src/schema/json-schema.ts`
- Modify: `src/fixtures/source.ts` (use the extracted helper)
- Modify: `src/mcp/tools/read.ts`
- Test: `test/mcp/describe.test.ts`, `test/schema/json-schema.test.ts`

**Interfaces:**
- Produces: `toJsonSchema(schema, compiler): Record<string, unknown> | undefined`.

Invariant 1 says one schema interpretation. `schemaHash` and `buildRequest`
each inline `compiler.compile()` then `z.toJSONSchema()` in a try/catch; this
task extracts that one derivation rather than adding a third copy.

**Verified against zod 4:** a recursive schema converts fine, emitting
`{"$ref":"#"}`. There is no recursion special-case to write. The `undefined`
branch is for whatever zod genuinely cannot express, and is defensive.

- [ ] **Step 1: Write the failing test for the extraction**

Create `test/schema/json-schema.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { toJsonSchema } from '../../src/schema/json-schema.ts'

test('converts a schema to JSON Schema', () => {
  const json = toJsonSchema(
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    createCompiler()
  )

  assert.equal(json?.type, 'object')
  assert.deepEqual(json?.required, ['id'])
})

test('converts a self-referential schema without throwing', () => {
  const node: Record<string, unknown> = { type: 'object', properties: {} }
  ;(node.properties as Record<string, unknown>).child = node

  const json = toJsonSchema(node as never, createCompiler())

  assert.ok(json, 'a recursive schema must convert, not vanish')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/schema/json-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/schema/json-schema.ts`**

```ts
import { z } from 'zod'
import type { Schema } from '../spec/types.ts'
import type { Compiler } from './compile.ts'

/**
 * The single Schema → JSON Schema derivation. `schemaHash`, `buildRequest`,
 * and `describe_operation` all route through here, because invariant 1's
 * reasoning applies to this conversion too: three copies would eventually
 * disagree, and a fixture hashed against one shape while described as another
 * is the exact bug class that invariant exists to prevent.
 *
 * Returns `undefined` for a schema zod cannot express as JSON Schema, which
 * callers treat as "nothing to say" rather than fabricating a shape. Recursion
 * is NOT such a case — zod emits `{"$ref":"#"}` and this returns it.
 */
export function toJsonSchema(
  schema: Schema,
  compiler: Compiler
): Record<string, unknown> | undefined {
  try {
    return z.toJSONSchema(compiler.compile(schema)) as Record<string, unknown>
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: Run it, then route `fixtures/source.ts` through it**

Run: `node --test test/schema/json-schema.test.ts`
Expected: PASS.

In `src/fixtures/source.ts`, replace the body of `schemaHash` with:

```ts
export function schemaHash(schema: Schema, compiler: Compiler): string | undefined {
  const jsonSchema = toJsonSchema(schema, compiler)
  if (jsonSchema === undefined) return undefined
  return fnv1a(JSON.stringify(jsonSchema)).toString(16).padStart(8, '0')
}
```

and inside `buildRequest`, replace its local `try { jsonSchema = z.toJSONSchema(zodSchema) ... }`
block with a `toJsonSchema` call, returning `undefined` where the catch did.
Add `import { toJsonSchema } from '../schema/json-schema.ts'`. Keep every
surrounding behavior — the structural-keys check in `buildRequest` stays
exactly as it is.

Run: `npm test`
Expected: clean. The fixture tests are the regression net for this extraction;
if any fail, the extraction changed behavior and must be corrected, not the
tests.

- [ ] **Step 5: Write the failing test for the two tools**

Create `test/mcp/describe.test.ts`, importing `contextFor` and `toolNamed`
from `./helpers.ts` (created in Task 2).

```ts
test('describe_operation returns params, bodies, responses, and security', async () => {
  const result = (await toolNamed('describe_operation').handler(
    contextFor(), { operationId: 'createOrder' }
  )) as {
    method: string
    path: string
    parameters: Array<{ name: string; location: string; required: boolean }>
    requestBody?: { required: boolean; content: Record<string, unknown> }
    responses: Array<{ status: number; schema?: Record<string, unknown> }>
    security: unknown
  }

  assert.equal(result.method, 'POST')
  assert.equal(result.path, '/orders')
  assert.equal(result.requestBody?.required, true)
  assert.deepEqual(result.responses.map((entry) => entry.status), [201, 400])

  const created = result.responses.find((entry) => entry.status === 201)
  assert.equal(created?.schema?.type, 'object')
  assert.deepEqual(created?.schema?.required, ['id', 'total'])
})

test('describe_operation addresses an operation by method and path too', async () => {
  const result = (await toolNamed('describe_operation').handler(
    contextFor(), { method: 'get', path: '/orders/{orderId}' }
  )) as { operationId?: string }

  assert.equal(result.operationId, 'getOrder')
})

test('describe_operation reports an unknown operation as an error', async () => {
  await assert.rejects(
    async () => toolNamed('describe_operation').handler(contextFor(), { operationId: 'nope' }),
    /nope/
  )
})

test('get_auth_requirements narrows to one operation when asked', async () => {
  const scoped = (await toolNamed('get_auth_requirements').handler(
    contextFor(), { operationId: 'createOrder' }
  )) as { requirements: unknown; schemes: Record<string, unknown> }

  assert.deepEqual(scoped.requirements, [{ apiKeyAuth: [] }])
  assert.ok(scoped.schemes.apiKeyAuth, 'the named scheme must be described')
})

test('get_auth_requirements reports an operation that opted out of auth', async () => {
  const scoped = (await toolNamed('get_auth_requirements').handler(
    contextFor(), { operationId: 'health' }
  )) as { requirements: unknown[] }

  // `security: []` in the document means "no auth", which must not be
  // confused with "inherits the document default".
  assert.deepEqual(scoped.requirements, [])
})

test('get_auth_requirements describes the whole document when unscoped', async () => {
  const all = (await toolNamed('get_auth_requirements').handler(contextFor(), {})) as {
    schemes: Record<string, unknown>
  }

  assert.deepEqual(Object.keys(all.schemes).sort(), ['apiKeyAuth', 'bearerAuth'])
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `node --test test/mcp/describe.test.ts`
Expected: FAIL — `no tool named describe_operation`.

- [ ] **Step 7: Implement both tools**

In `src/mcp/tools/read.ts`, add a shared operation lookup and the two tools.

```ts
import { createCompiler } from '../../schema/compile.ts'
import { toJsonSchema } from '../../schema/json-schema.ts'
import type { Operation, Schema } from '../../spec/types.ts'

// One compiler for the module: compilation is pure and its cache is a win
// across calls. It holds no per-request state.
const compiler = createCompiler()

export function findOperation(
  ctx: McpContext,
  args: Record<string, unknown>
): Operation {
  const operationId = args.operationId as string | undefined
  const method = (args.method as string | undefined)?.toLowerCase()
  const path = args.path as string | undefined

  if (operationId !== undefined) {
    const found = ctx.api.operations.find((op) => op.operationId === operationId)
    if (found === undefined) {
      throw new Error(
        `mockingham: no operation with operationId "${operationId}". ` +
          'Call list_operations to see what this document declares.'
      )
    }
    return found
  }
  if (method !== undefined && path !== undefined) {
    const found = ctx.api.operations.find((op) => op.method === method && op.path === path)
    if (found === undefined) {
      throw new Error(
        `mockingham: no operation for ${method.toUpperCase()} ${path}. ` +
          'The path must be the templated form, for example /orders/{orderId}.'
      )
    }
    return found
  }
  throw new Error(
    'mockingham: identify the operation with either operationId, or both method and path.'
  )
}

function contentSchemas(
  content: Record<string, { schema: Schema; example?: unknown }> | undefined
): Record<string, unknown> | undefined {
  if (content === undefined) return undefined
  const out: Record<string, unknown> = {}
  // Sorted: media type keys come from an object, and invariant 2 forbids
  // letting object key order decide output.
  for (const mediaType of Object.keys(content).sort()) {
    const media = content[mediaType]!
    out[mediaType] = {
      schema: toJsonSchema(media.schema, compiler) ?? {
        $comment: 'not expressible as JSON Schema; this operation is generated only'
      },
      example: media.example
    }
  }
  return out
}

const describeOperation: McpTool = {
  name: 'describe_operation',
  description:
    'The full contract for one operation: parameters, request body schema, ' +
    'every declared response schema, security requirements, and declared ' +
    'examples. Identify it by operationId, or by method and path.',
  inputSchema: {
    operationId: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional().describe('Templated form, e.g. /orders/{orderId}')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const operation = findOperation(ctx, args)
    return {
      method: operation.method.toUpperCase(),
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary,
      description: operation.description,
      tags: operation.tags,
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        location: parameter.location,
        required: parameter.required,
        schema: toJsonSchema(parameter.schema, compiler)
      })),
      requestBody: operation.requestBody
        ? {
            required: operation.requestBodyRequired === true,
            content: contentSchemas(operation.requestBody)
          }
        : undefined,
      responses: [...operation.responses]
        .sort((a, b) => a.status - b.status)
        .map((response) => ({
          status: response.status,
          description: response.description,
          content: contentSchemas(response.content),
          // Convenience: the JSON body schema most callers actually want,
          // lifted out of `content` so an agent does not have to know the
          // media-type key to find it.
          schema: response.content['application/json']
            ? toJsonSchema(response.content['application/json']!.schema, compiler)
            : undefined
        })),
      security: operation.security
    }
  }
}

const getAuthRequirements: McpTool = {
  name: 'get_auth_requirements',
  description:
    'Security schemes this API declares, and the requirements that apply — ' +
    'for one operation when operationId is given, for the document otherwise. ' +
    'An empty requirements array means the operation needs no auth.',
  inputSchema: { operationId: z.string().optional() },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const scoped = args.operationId !== undefined ? findOperation(ctx, args) : undefined
    return {
      schemes: ctx.api.securitySchemes,
      requirements: scoped?.security,
      // Stated rather than left to inference: `security: []` and an absent
      // `security` mean different things, and an agent reading `[]` should not
      // have to guess which one it is looking at.
      note:
        scoped !== undefined && Array.isArray(scoped.security) && scoped.security.length === 0
          ? 'This operation explicitly requires no authentication.'
          : undefined
    }
  }
}
```

Add both to `READ_TOOLS`.

- [ ] **Step 8: Run the test to verify it passes**

Run: `node --test test/mcp/describe.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Verify the mutation**

In `describeOperation`, change the responses `.sort(...)` to no sort and
reverse the array instead. The status-order assertion must fail. Revert. Then
in `getAuthRequirements`, change `requirements: scoped?.security` to
`requirements: ctx.api.operations[0]?.security` — the `health` test must fail.
Revert.

- [ ] **Step 10: Typecheck, full suite, commit**

```sh
git add src/schema/json-schema.ts src/fixtures/source.ts src/mcp/tools/read.ts test/schema/json-schema.test.ts test/mcp
git commit -m 'feat: describe_operation and get_auth_requirements' -m 'Extracts the Schema to JSON Schema derivation that schemaHash and buildRequest each inlined. Invariant 1 applies to this conversion too: three copies would eventually disagree.'
```

---

## Task 5: `sample_response`

Design amendments 3.2 and 3.3. The tool that earns the MCP server its place.

**Files:**
- Modify: `src/mcp/tools/read.ts`
- Test: `test/mcp/sample-response.test.ts`

**Interfaces:**
- Consumes: `findOperation` from Task 4, `McpContext.origin` and
  `McpContext.fetch` from Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/mcp/sample-response.test.ts`:

```ts
test('sample_response returns exactly what mock.fetch returns', async () => {
  const mock = createMock(mcpDoc)
  const ctx = contextForMock(mock)

  const sample = (await toolNamed('sample_response').handler(ctx, {
    operationId: 'getOrder',
    params: { orderId: 'abc' }
  })) as { status: number; body: unknown; url: string }

  const direct = await mock.fetch(new Request('http://mock.local/orders/abc'))

  assert.equal(sample.status, direct.status)
  assert.deepEqual(sample.body, await direct.json())
  assert.equal(sample.url, 'http://mock.local/orders/abc')
})

test('sample_response synthesizes a missing path parameter that satisfies its schema', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder'
  })) as { status: number; url: string }

  assert.equal(sample.status, 200)
  const orderId = new URL(sample.url).pathname.split('/').pop() as string
  // The document declares minLength 3; a synthesized value that violated it
  // would 400 under request validation and tell the agent nothing.
  assert.ok(orderId.length >= 3, `synthesized orderId "${orderId}" is too short`)
})

test('the same call twice is byte-identical', async () => {
  // Master spec section 17's determinism requirement, at this surface.
  const ctx = contextFor()
  const first = (await toolNamed('sample_response').handler(ctx, { operationId: 'getOrder' }))
  const second = (await toolNamed('sample_response').handler(ctx, { operationId: 'getOrder' }))

  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('a synthesized path parameter is stable across calls and across seeds', async () => {
  const first = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder'
  })) as { url: string }
  const second = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'getOrder'
  })) as { url: string }
  assert.equal(first.url, second.url)

  const reseeded = createMock(mcpDoc, { seed: 'a-totally-different-seed' })
  const third = (await toolNamed('sample_response').handler(contextForMock(reseeded), {
    operationId: 'getOrder'
  })) as { url: string }

  // A synthesized parameter is an address, not content: set_seed must change
  // what /orders/X returns, not turn it into /orders/Y. Design section 3.2.
  assert.equal(third.url, first.url)
})

test('the response body does change with the seed', async () => {
  const a = (await toolNamed('sample_response').handler(
    contextForMock(createMock(mcpDoc, { seed: 'seed-a' })), { operationId: 'getOrder' }
  )) as { body: unknown }
  const b = (await toolNamed('sample_response').handler(
    contextForMock(createMock(mcpDoc, { seed: 'seed-b' })), { operationId: 'getOrder' }
  )) as { body: unknown }

  assert.notDeepEqual(a.body, b.body)
})

test('sample_response honors a requested status', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'createOrder',
    status: 400,
    body: { id: 'x', total: 1 }
  })) as { status: number; body: Record<string, unknown> }

  assert.equal(sample.status, 400)
  assert.equal(typeof sample.body.message, 'string')
})

test('sample_response passes query parameters through', async () => {
  const sample = (await toolNamed('sample_response').handler(contextFor(), {
    operationId: 'listOrders',
    query: { limit: 5 }
  })) as { url: string; status: number }

  assert.equal(sample.status, 200)
  assert.ok(sample.url.endsWith('/orders?limit=5'), sample.url)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/mcp/sample-response.test.ts`
Expected: FAIL — `no tool named sample_response`.

- [ ] **Step 3: Implement it**

In `src/mcp/tools/read.ts`:

```ts
import { createRng } from '../../generate/rng.ts'
import { generateValue } from '../../generate/generate.ts'

/**
 * A path parameter the caller did not supply. Seeded on the operation and
 * parameter name and NOT on the mock's root seed: a synthesized parameter is
 * an address, not content. `set_seed` must change what `/orders/abc` returns
 * without turning it into `/orders/xyz` — otherwise every sample an agent
 * recorded stops resolving the moment anything reseeds. It also keeps fixture
 * keys stable, since fixtureKey includes params.
 *
 * Generated through the same generateValue the mock itself uses, so the value
 * satisfies the parameter's declared schema and survives request validation.
 */
function synthesizeParam(operation: Operation, parameter: Parameter): string {
  const rng = createRng(`${operation.operationId ?? operation.path}|${parameter.name}`)
  const value = generateValue(parameter.schema, rng, { schemaNames: new Map() })
  return String(value)
}

const sampleResponse: McpTool = {
  name: 'sample_response',
  description:
    'A live response for an operation, produced by the real request pipeline — ' +
    'the exact bytes your code will receive, not a schema you have to guess ' +
    'from. Path parameters you omit are filled with schema-valid values. Use ' +
    '`status` to ask for a specific declared response.',
  inputSchema: {
    operationId: z.string().optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    params: z.record(z.string(), z.union([z.string(), z.number()])).optional()
      .describe('Path parameter values, e.g. { orderId: "abc" }'),
    query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    status: z.number().optional().describe('Ask for a specific declared status')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    const operation = findOperation(ctx, args)
    const supplied = (args.params ?? {}) as Record<string, string | number>

    let path = operation.path
    for (const parameter of operation.parameters) {
      if (parameter.location !== 'path') continue
      const value = supplied[parameter.name] !== undefined
        ? String(supplied[parameter.name])
        : synthesizeParam(operation, parameter)
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
    }

    const url = new URL(path, ctx.origin)
    const query = (args.query ?? {}) as Record<string, string | number>
    // Sorted: query keys arrive as object keys, and invariant 2 forbids object
    // key order deciding a URL that feeds generation.
    for (const name of Object.keys(query).sort()) {
      url.searchParams.set(name, String(query[name]))
    }

    const headers = new Headers((args.headers ?? {}) as Record<string, string>)
    if (args.status !== undefined) {
      // The same mechanism a real client uses (master spec section 2), so this
      // introduces no second status-selection path.
      headers.set('prefer', `status=${String(args.status)}`)
    }

    const method = operation.method.toUpperCase()
    const sendsBody = method !== 'GET' && method !== 'HEAD' && args.body !== undefined
    if (sendsBody && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }

    const response = await ctx.fetch(new Request(url, {
      method,
      headers,
      body: sendsBody ? JSON.stringify(args.body) : undefined
    }))

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => { responseHeaders[name] = value })
    const text = await response.text()
    const isJson = (response.headers.get('content-type') ?? '').includes('json')

    return {
      status: response.status,
      headers: responseHeaders,
      // Parsed when it is JSON so an agent reads a structure rather than an
      // escaped string; the raw text otherwise.
      body: isJson && text.length > 0 ? JSON.parse(text) : text,
      url: url.toString()
    }
  }
}
```

Add to `READ_TOOLS`. Import `Parameter` from `../../spec/types.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/mcp/sample-response.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify the mutations**

1. Change `synthesizeParam` to seed on
   `` `${ctx.seed}|${operation.operationId}|${parameter.name}` `` — you will
   have to thread a seed in to do it, which is the point. The
   "stable across seeds" test must fail. Revert.
2. Change the `prefer` header name to `x-prefer`. The requested-status test
   must fail with 201 instead of 400. Revert.
3. Delete the query `.sort()`. This one probably still passes with a single
   query key — that is expected, and it means the sort is defense rather than
   a tested behavior. Note it in your report rather than adding a contrived
   two-key test.

- [ ] **Step 6: Typecheck, full suite, commit**

```sh
git add src/mcp/tools/read.ts test/mcp/sample-response.test.ts
git commit -m 'feat: sample_response' -m 'It IS mock.fetch rather than a second generation path, so the no-drift guarantee in master spec section 17 is structural instead of asserted. Synthesized path parameters are addresses, not content: seeded independently of the root seed so reseeding changes the body without moving the URL.'
```

---

## Task 6: `search_operations`, `list_webhooks`, `list_deliveries`

**Files:**
- Modify: `src/mcp/tools/read.ts`
- Test: `test/mcp/search-webhooks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('search_operations matches path, summary, description, and tags', async () => {
  const bySummary = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'place an order' }
  )) as Array<{ operationId?: string }>
  assert.equal(bySummary[0]?.operationId, 'createOrder')

  const byTag = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'ops' }
  )) as Array<{ operationId?: string }>
  assert.ok(byTag.some((entry) => entry.operationId === 'health'))

  const byDescription = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'every order the caller' }
  )) as Array<{ operationId?: string }>
  assert.equal(byDescription[0]?.operationId, 'listOrders')
})

test('search_operations is case-insensitive and honors limit', async () => {
  const result = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'ORDER', limit: 2 }
  )) as unknown[]
  assert.equal(result.length, 2)
})

test('search_operations returns an empty array rather than erroring on no match', async () => {
  const result = (await toolNamed('search_operations').handler(
    contextFor(), { query: 'zzzz-no-such-thing' }
  )) as unknown[]
  assert.deepEqual(result, [])
})

test('list_webhooks reports declared webhooks and callbacks with their payload schemas', async () => {
  const result = (await toolNamed('list_webhooks').handler(contextFor(), {})) as Array<{
    name: string
    kind: string
    emittedBy: string[]
    payloadSchema?: Record<string, unknown>
    expression?: string
  }>

  const created = result.find((entry) => entry.name === 'orderCreated')
  assert.equal(created?.kind, 'webhook')
  assert.deepEqual(created?.payloadSchema?.required, ['id'])

  const shipped = result.find((entry) => entry.name === 'orderShipped')
  assert.equal(shipped?.kind, 'callback')
  assert.deepEqual(shipped?.emittedBy, ['POST /orders'])
  assert.equal(shipped?.expression, '{$request.body#/callbackUrl}')
})

test('list_webhooks reports an empty emittedBy for a webhook nothing fires', async () => {
  const result = (await toolNamed('list_webhooks').handler(contextFor(), {})) as Array<{
    name: string
    emittedBy: string[]
  }>

  // Honest and useful: the document declares it, but no operation config emits
  // it — which is exactly the misconfiguration worth telling an agent about.
  assert.deepEqual(result.find((entry) => entry.name === 'orderCreated')?.emittedBy, [])
})

test('list_webhooks reflects the configured emitters', async () => {
  const options = {
    operations: { 'POST /orders': { emits: [{ webhook: 'orderCreated' }] } },
    webhooks: { orderCreated: { url: 'https://example.test/hook' } }
  }
  const mock = createMock(mcpDoc, options)
  const result = (await toolNamed('list_webhooks').handler(
    contextForMock(mock, options), {}
  )) as Array<{ name: string; emittedBy: string[] }>

  assert.deepEqual(result.find((entry) => entry.name === 'orderCreated')?.emittedBy, ['POST /orders'])
})

test('list_deliveries filters by webhook and by outcome', async () => {
  const mock = createMock(mcpDoc, {
    webhooks: { orderCreated: { url: 'https://example.test/hook' } },
    captureOnly: true
  })
  await mock.emit('orderCreated')
  await mock.settled()

  const ctx = contextForMock(mock)
  const all = (await toolNamed('list_deliveries').handler(ctx, {})) as unknown[]
  assert.equal(all.length, 1)

  const matching = (await toolNamed('list_deliveries').handler(
    ctx, { webhook: 'orderCreated' }
  )) as unknown[]
  assert.equal(matching.length, 1)

  const other = (await toolNamed('list_deliveries').handler(
    ctx, { webhook: 'somethingElse' }
  )) as unknown[]
  assert.deepEqual(other, [])

  const wrongOutcome = (await toolNamed('list_deliveries').handler(
    ctx, { outcome: 'unresolved' }
  )) as unknown[]
  assert.deepEqual(wrongOutcome, [])
})
```

Note the second argument in the configured-emitters test:
`contextForMock(mock, { operations: {...} })`. `emitters` is derived from the
`operations` config and cannot be recovered from a constructed `Mock`, so the
helper needs the same config the mock was built with. Passing the mock alone
would silently produce an empty emitters map and the test would fail on
`['POST /orders']` — which is the correct failure, not a helper bug.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/mcp/search-webhooks.test.ts`
Expected: FAIL — tools not found.

- [ ] **Step 3: Implement the three tools**

```ts
const searchOperations: McpTool = {
  name: 'search_operations',
  description:
    'Free-text search over path, summary, description, and tags. Use this when ' +
    'you know what you want to do but not what it is called.',
  inputSchema: {
    query: z.string().describe('Free text; matched case-insensitively as a substring'),
    limit: z.number().int().positive().optional()
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const query = String(args.query ?? '').toLowerCase().trim()
    const limit = (args.limit as number | undefined) ?? 20
    if (query.length === 0) return []

    const scored = ctx.api.operations
      .map((operation) => {
        const haystacks = [
          operation.path,
          operation.summary ?? '',
          operation.description ?? '',
          operation.tags.join(' '),
          operation.operationId ?? ''
        ].map((text) => text.toLowerCase())

        // Ranked by WHERE it matched, not by how often: a summary hit is a
        // better answer than an incidental description hit, and an agent
        // reading the first result should get the best one.
        let score = 0
        if (haystacks[1]!.includes(query)) score += 8
        if (haystacks[4]!.includes(query)) score += 6
        if (haystacks[0]!.includes(query)) score += 4
        if (haystacks[3]!.includes(query)) score += 3
        if (haystacks[2]!.includes(query)) score += 1
        return { operation, score }
      })
      .filter((entry) => entry.score > 0)

    // Stable: equal scores keep document order, because sort() is stable in
    // Node and `scored` was built by walking operations in order.
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map((entry) => ({
      method: entry.operation.method.toUpperCase(),
      path: entry.operation.path,
      operationId: entry.operation.operationId,
      summary: entry.operation.summary,
      tags: entry.operation.tags
    }))
  }
}

const listWebhooks: McpTool = {
  name: 'list_webhooks',
  description:
    'Outbound requests this API can make — top-level webhooks and per-operation ' +
    'callbacks — with payload schemas and which operations are configured to ' +
    'emit them. An empty emittedBy means the document declares it but nothing ' +
    'fires it.',
  inputSchema: {},
  handler(ctx: McpContext) {
    const callbacks = new Map<string, { expression: string; owner: string }>()
    for (const operation of ctx.api.operations) {
      for (const callback of operation.callbacks) {
        if (callbacks.has(callback.name)) continue
        callbacks.set(callback.name, {
          expression: callback.expression,
          owner: `${operation.method.toUpperCase()} ${operation.path}`
        })
      }
    }

    // Sorted: api.webhooks is an object, and invariant 2 forbids object key
    // order deciding output.
    return Object.keys(ctx.api.webhooks).sort().map((name) => {
      const webhook = ctx.api.webhooks[name]!
      const callback = callbacks.get(name)
      const media = webhook.body?.['application/json']
      const configured = ctx.emitters.get(name) ?? []
      return {
        name,
        kind: callback === undefined ? 'webhook' : 'callback',
        method: webhook.method.toUpperCase(),
        payloadSchema: media ? toJsonSchema(media.schema, compiler) : undefined,
        // A callback's owning operation is declared in the document, so it is
        // reported whether or not anything is configured to emit it. A
        // top-level webhook has no declared owner — only config can link it.
        emittedBy: callback !== undefined && configured.length === 0
          ? [callback.owner]
          : configured,
        expression: callback?.expression
      }
    })
  }
}

const listDeliveries: McpTool = {
  name: 'list_deliveries',
  description:
    'Webhook deliveries this mock has made so far, oldest first — the feedback ' +
    'loop for verifying your own receiver. Filter by webhook name or outcome.',
  inputSchema: {
    webhook: z.string().optional(),
    outcome: z.string().optional().describe('e.g. captured, delivered, unresolved')
  },
  handler(ctx: McpContext, args: Record<string, unknown>) {
    const webhook = args.webhook as string | undefined
    const outcome = args.outcome as string | undefined
    // Filtered here rather than by widening Mock.deliveries() — design 3.9.
    return ctx.deliveries()
      .filter((delivery) => webhook === undefined || delivery.webhook === webhook)
      .filter((delivery) => outcome === undefined || delivery.outcome === outcome)
  }
}
```

Add all three to `READ_TOOLS`.

- [ ] **Step 4: Run, verify the mutation, commit**

Run: `node --test test/mcp/search-webhooks.test.ts` — expected PASS.

Mutation: in `searchOperations`, drop `operation.tags.join(' ')` from
`haystacks` (leave a `''` in its place so indices hold). The tag search must
fail. Revert. Then in `listWebhooks`, change `emittedBy` to always be
`configured` — the callback test must fail on `['POST /orders']`. Revert.

Run: `npx tsc --noEmit`
Run: `npm test`

```sh
git add src/mcp/tools/read.ts test/mcp
git commit -m 'feat: search_operations, list_webhooks, list_deliveries' -m 'list_webhooks answers which operations emit what from two sources, because only half of it is derivable from the document: a callback declares its owner, a top-level webhook is linked only by mockingham config.'
```

---

## Task 7: The write tools and the gate

**Files:**
- Create: `src/mcp/tools/write.ts`
- Modify: `src/mcp/tools/index.ts`
- Test: `test/mcp/write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('write tools are absent from the default tool list', () => {
  const names = mcpTools().map((tool) => tool.name)
  for (const name of ['fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset']) {
    assert.ok(!names.includes(name), `${name} must not be exposed without write: true`)
  }
})

test('write tools appear when write is enabled', () => {
  const names = mcpTools({ write: true }).map((tool) => tool.name)
  assert.deepEqual(
    ['fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset']
      .filter((name) => names.includes(name)),
    ['fail_next', 'outage', 'emit_webhook', 'set_seed', 'reset']
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

  // And it must not have taken effect.
  const check = await mock.fetch(new Request('http://mock.local/orders'))
  assert.equal(check.status, 200)
})

test('fail_next drives the next request to an error when the gate is open', async () => {
  const mock = createMock(mcpDoc)
  const ctx = contextForMock(mock)
  await toolNamed('fail_next', { write: true }).handler(ctx, {
    target: 'GET /orders', status: 503
  })

  const failed = await mock.fetch(new Request('http://mock.local/orders'))
  assert.equal(failed.status, 503)
  const recovered = await mock.fetch(new Request('http://mock.local/orders'))
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

  const before = await (await mock.fetch(new Request('http://mock.local/orders/abc'))).json()
  await toolNamed('set_seed', { write: true }).handler(ctx, { seed: 'second' })
  const after = await (await mock.fetch(new Request('http://mock.local/orders/abc'))).json()
  assert.notDeepEqual(before, after)

  await toolNamed('fail_next', { write: true }).handler(ctx, { target: 'GET /orders' })
  await toolNamed('reset', { write: true }).handler(ctx, {})
  const recovered = await mock.fetch(new Request('http://mock.local/orders'))
  assert.equal(recovered.status, 200, 'reset must clear armed failures')
})
```

`toolNamed` needs a second argument now — update the helper to take
`McpToolOptions` and pass it to `mcpTools`.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/mcp/write.test.ts`
Expected: FAIL — module `write.ts` not found.

- [ ] **Step 3: Write `src/mcp/tools/write.ts`**

```ts
import { z } from 'zod'
import type { McpContext, McpTool } from '../context.ts'

const failNext: McpTool = {
  name: 'fail_next',
  description:
    'Make the next request(s) to a target fail, so you can exercise your error ' +
    'handling without waiting for a real outage. Target is a control-plane ' +
    'string: "POST /orders", an operationId, or "*".',
  inputSchema: {
    target: z.string(),
    times: z.number().int().positive().optional().describe('Default 1'),
    status: z.number().int().optional().describe('Default 503')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.failNext(String(args.target), {
      times: args.times as number | undefined,
      status: args.status as number | undefined
    })
    return { armed: args.target, times: args.times ?? 1, status: args.status ?? 503 }
  }
}

const outage: McpTool = {
  name: 'outage',
  description:
    'Fail every request to a target for a window of time. Use this for retry ' +
    'and circuit-breaker behavior; use fail_next for a single failure.',
  inputSchema: {
    target: z.string(),
    forMs: z.number().int().positive().optional(),
    status: z.number().int().optional().describe('Default 503')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.outage(String(args.target), {
      forMs: args.forMs as number | undefined,
      status: args.status as number | undefined
    })
    return { target: args.target, forMs: args.forMs, status: args.status ?? 503 }
  }
}

const emitWebhook: McpTool = {
  name: 'emit_webhook',
  description:
    'Fire a declared webhook now, optionally at a URL you choose — so you can ' +
    'test your receiver without provoking the flow that would trigger it. ' +
    'Returns the delivery, including outcome "unresolved" when nothing ' +
    'supplied a destination.',
  inputSchema: {
    webhook: z.string(),
    to: z.string().optional().describe('Destination URL; wins over any configured one'),
    body: z.unknown().optional().describe('Layered over the generated payload')
  },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    // Returned as-is. Invariant 6: an unresolved emit is a captured outcome,
    // never an error, and must not be converted into one here.
    return ctx.emit(String(args.webhook), {
      to: args.to as string | undefined,
      body: args.body as never
    })
  }
}

const setSeed: McpTool = {
  name: 'set_seed',
  description:
    'Reshuffle every generated value. The mock stays deterministic — the same ' +
    'seed always produces the same content.',
  inputSchema: { seed: z.string() },
  async handler(ctx: McpContext, args: Record<string, unknown>) {
    await ctx.setSeed(String(args.seed))
    return { seed: args.seed }
  }
}

const reset: McpTool = {
  name: 'reset',
  description:
    'Restore the configured baseline: clears armed failures, idempotency keys, ' +
    'counters, and captured deliveries. Never touches your config file.',
  inputSchema: {},
  async handler(ctx: McpContext) {
    await ctx.reset()
    return { reset: true }
  }
}

export const WRITE_TOOLS: McpTool[] = [failNext, outage, emitWebhook, setSeed, reset]
```

- [ ] **Step 4: Close the gate in `tools/index.ts`**

```ts
import { READ_TOOLS } from './read.ts'
import { WRITE_TOOLS } from './write.ts'

export function mcpTools(options: McpToolOptions = {}): McpTool[] {
  return options.write === true ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS]
}
```

Because the server registers only what `mcpTools` returns, a `tools/call` for
an unregistered name is refused by the SDK with "tool not found". That is the
second half of the gate, but it does not name the flag. Add that to
`src/mcp/server.ts`'s `register`, after the loop:

```ts
  // With the gate closed, a caller who knows a write tool's name gets a
  // refusal that says how to enable it, rather than the SDK's bare "not
  // found" — which reads like the feature does not exist.
  //
  // The names come from WRITE_TOOLS rather than a literal list: a sixth write
  // tool added later must not silently lose its refusal message.
  const exposed = new Set(tools.map((tool) => tool.name))
  for (const disabled of WRITE_TOOLS.filter((tool) => !exposed.has(tool.name))) {
    server.registerTool(
      disabled.name,
      {
        description:
          `Disabled. ${disabled.name} changes the mock's runtime state, so it ` +
          'is off by default. Enable the write tools with mcp({ write: true }) ' +
          'or the --write flag.'
      },
      async () => {
        throw new Error(
          `mockingham: ${disabled.name} is a write tool and write tools are ` +
            'disabled. Enable them with mcp({ write: true }) or --write.'
        )
      }
    )
  }
```

Add `import { WRITE_TOOLS } from './tools/write.ts'` to `server.ts`. This is a
pure module importing into the impure one, which is the allowed direction.

- [ ] **Step 5: Run, verify the mutation, commit**

Run: `node --test test/mcp/write.test.ts` — expected PASS.

Mutation: in `tools/index.ts`, change the gate to
`return [...READ_TOOLS, ...WRITE_TOOLS]` unconditionally. The first test and
the `tools/call` refusal test must both fail. Revert. Then delete the
`assert.equal(check.status, 200)` line's cause by making the disabled stub call
`ctx.failNext` instead of throwing — the refusal test must fail on the status
check. Revert.

Run: `npx tsc --noEmit`
Run: `npm test`

```sh
git add src/mcp test/mcp/write.test.ts
git commit -m 'feat: the five write tools, opt-in on both transports' -m 'Design 3.7. Both halves of the gate: tools/list omits them, and tools/call names the flag that would enable them instead of reporting the tool as nonexistent.'
```

---

## Task 8: The `mcp` CLI subcommand and the stdio round trip

**Files:**
- Modify: `src/server/cli.ts`
- Test: `test/server/cli-mcp.test.ts`

**Interfaces:**
- Consumes: `createMock` and `Mock.mcp` from Task 3, `connectStdio` from Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/server/cli-mcp.test.ts`. This is the one test that spawns a real
subprocess and speaks the real protocol.

```ts
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
  } finally {
    await client.close()
  }
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/server/cli-mcp.test.ts`
Expected: FAIL — `parseMcpArgs` is not exported.

- [ ] **Step 3: Add the subcommand to `src/server/cli.ts`**

```ts
export const MCP_USAGE = `mockingham mcp — serve the MCP tools over stdio

  mockingham mcp <document.json> [options]

  --seed <s>        Generation seed (default: mockingham)
  --fixtures <dir>  Serve committed fixture files from this directory
  --write           Expose the write tools (fail_next, outage, emit_webhook,
                     set_seed, reset). Off by default: they change the mock's
                     runtime state.
  --help, -h        Show this message

YAML is not parsed. Convert the document to JSON first.
`

export interface McpArgs {
  document?: string
  seed?: string
  fixtures?: string
  write: boolean
  help: boolean
}

const MCP_NEEDS_VALUE = new Set(['--seed', '--fixtures'])

export function parseMcpArgs(argv: string[]): McpArgs {
  const args: McpArgs = {
    document: undefined,
    seed: undefined,
    fixtures: undefined,
    write: false,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string

    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }
    if (token === '--write') {
      args.write = true
      continue
    }

    if (token.startsWith('--')) {
      const split = token.indexOf('=')
      const name = split === -1 ? token : token.slice(0, split)
      if (!MCP_NEEDS_VALUE.has(name)) {
        throw new Error(`mockingham: unknown option ${name}\n\n${MCP_USAGE}`)
      }
      const value = split === -1 ? argv[++i] : token.slice(split + 1)
      if (value === undefined) {
        throw new Error(`mockingham: ${name} needs a value`)
      }
      if (name === '--seed') args.seed = value
      else args.fixtures = value
      continue
    }

    if (args.document !== undefined) {
      throw new Error(`mockingham: unexpected argument "${token}"`)
    }
    args.document = token
  }

  return args
}

export interface McpCliDeps {
  readFile: (path: string) => Promise<string>
  /**
   * stderr, NOT stdout. stdout is the JSON-RPC channel over stdio, and one
   * stray log line corrupts the stream for the whole session. This is the one
   * place the project's `log` convention bends, and it bends for a protocol
   * requirement rather than a preference.
   */
  log: (message: string) => void
}

export async function startMcp(
  argv: string[],
  deps: Partial<McpCliDeps> = {}
): Promise<{ close(): Promise<void> }> {
  const readFile = deps.readFile ?? ((path: string) => readFileFromDisk(path, 'utf8'))
  const log = deps.log ?? ((message: string) => console.error(message))

  const args = parseMcpArgs(argv)
  if (args.help) {
    log(MCP_USAGE)
    throw new Error('mockingham: nothing to serve')
  }
  if (args.document === undefined) {
    throw new Error(`mockingham: a document path is required\n\n${MCP_USAGE}`)
  }
  if (args.document.endsWith('.yaml') || args.document.endsWith('.yml')) {
    throw new Error(
      'mockingham: YAML documents are not parsed. Convert to JSON, or call ' +
        'createMock() from a script with the document already parsed.'
    )
  }

  const text = await readFile(args.document)
  // createMock, not createHandler: the write tools need failNext, outage, and
  // emit, which live on Mock rather than Handler.
  const mock = createMock(JSON.parse(text) as Record<string, unknown>, {
    seed: args.seed,
    fixtures: args.fixtures !== undefined
      ? { store: await createDiskFixtureStore({ dir: args.fixtures, onWarn: log }) }
      : undefined,
    onWarn: log
  })

  const server = mock.mcp({ transport: 'stdio', write: args.write })
  await server.connectStdio()
  log(`mockingham: MCP server ready for ${args.document}`)

  return {
    async close() {
      await server.close()
      await mock.close()
    }
  }
}
```

Import `createMock` from `../index.ts` at the top of `cli.ts`.

Then in the `import.meta.main` block, add the branch before the `bake` one:

```ts
    if (argv[0] === 'mcp') {
      const mcpArgv = argv.slice(1)
      if (parseMcpArgs(mcpArgv).help) {
        console.error(MCP_USAGE)
      } else {
        await startMcp(mcpArgv)
      }
    } else if (argv[0] === 'bake') {
```

And add the subcommand to `USAGE`:

```
  mockingham mcp <document.json> [options]    Serve the MCP tools over stdio
                                               (see: mockingham mcp --help)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/server/cli-mcp.test.ts`
Expected: PASS, 2 tests.

If the round-trip test hangs, the subprocess is writing to stdout. Check that
every `log` call in the `mcp` path goes to `console.error`.

- [ ] **Step 5: Verify the mutation**

Change `startMcp`'s default `log` from `console.error` to `console.log`. The
round-trip test must fail or time out, because the readiness line corrupts the
JSON-RPC stream. Revert. This is the mutation that matters most in this task —
if the test still passes with `console.log`, it is not exercising the stream.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npx tsc --noEmit`
Run: `npm test`
Expected: clean, and the process exits.

```sh
git add src/server/cli.ts test/server/cli-mcp.test.ts
git commit -m 'feat: mockingham mcp subcommand over stdio' -m 'All logging on this path goes to stderr: stdout is the JSON-RPC channel and one stray line corrupts the session.'
```

---

## Task 9: Pin the public surface

There is no `README.md` in this repository — documentation is phase 12, a
later plan. This task is the export surface only.

**Files:**
- Modify: `test/server/public-surface.test.ts`

- [ ] **Step 1: Extend the public-surface test**

`test/server/public-surface.test.ts` pins what the package exports. Add
assertions that `createMock(...).mcp` is a function and that the `McpOptions`
and `McpServerHandle` types are exported (a type-only import that compiles is
the assertion; `npx tsc --noEmit` is what checks it).

```ts
test('the package exposes the MCP server surface', () => {
  const mock = createMock(petstore)
  assert.equal(typeof mock.mcp, 'function')

  const handle = mock.mcp({ transport: 'inline' })
  assert.equal(typeof handle.handleRequest, 'function')
  assert.equal(typeof handle.connectStdio, 'function')
  assert.equal(handle.path, undefined, 'inline transport mounts nothing')
})
```

- [ ] **Step 2: Run it, then commit**

Run: `npm test`
Run: `npx tsc --noEmit`

```sh
git add test/server/public-surface.test.ts
git commit -m 'test: pin the MCP surface in the public-surface test'
```

---

## Self-review notes for the executor

Three things in this plan are known-soft. Rule on them and record the ruling;
do not stop to ask.

1. **`contextForMock` duplicates `createMock`'s context construction.** Tasks 2
   and 6 both build an `McpContext` by hand in test helpers, while `createMock`
   builds one in production. That is the exact seam shape that produced plan 7's
   two worst defects. If you can make `createMock` expose the context it builds
   — even as an internal export the tests import — do that instead, and the
   helper becomes a thin wrapper. Prefer that. If you cannot without widening
   the public surface, keep the duplicate and add a test that asserts the two
   agree on `emitters` for the same config.
2. **`search_operations`'s ranking weights are invented.** Nothing in the spec
   fixes them. They are ordered by intent (summary beats description) and the
   test only pins that ordering, not the numbers. Do not add tests that pin the
   numbers.
