# mockingham Plan 6 — Webhooks and Callbacks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mock emit outbound requests whose bodies conform to the
document's declared schemas — triggered imperatively or by an operation —
delivered with retry and HMAC signing, or captured in-process with no receiver.

**Architecture:** Five new modules that nothing existing imports; the dependency
arrow points one way, from the handler into webhooks. Emission reuses the
existing machinery wholesale — payloads come from seeded generation, are shaped
by the override layers, and carry layered headers. The only genuinely new code is
expression resolution, signing, and delivery. The hook point is the single exit
in `handle()`, where the response body is already captured.

**Tech Stack:** TypeScript (erasable syntax only, run directly by Node ≥ 24.2),
ESM, `node:test`, `zod` as the only hard runtime dependency. No new dependency —
signing uses the `crypto.subtle` global and delivery uses `fetch`.

## Source documents

- `docs/superpowers/specs/2026-08-12-mockingham-webhooks-design.md` — **this
  plan's contract.** Its §2 records six amendments where the master spec collides
  with an invariant or leaves a gap. Where the two disagree, it wins.
- `docs/superpowers/specs/2026-08-11-mockingham-design.md` — the master contract.
  §13 webhooks, §16 config surface, §17 testing, §18 phase 8.
- `docs/superpowers/deferred-items.md` — the process lessons, especially the
  test-shapes this project has learned to distrust.

## Global Constraints

Every task's requirements implicitly include these. Breaking one is a defect even
if the task's own tests pass.

- **Node ≥ 24.2, ESM, `"type": "module"`.** Types are stripped natively — no
  build step. The floor is 24.2 because `import.meta.main` needs it.
- **Erasable syntax only.** No `enum`, no `namespace`, no parameter properties.
  Use `const X = {...} as const`.
- **One schema interpretation.** `schema/walk.ts` is shared by value generation
  and zod compilation. Never add a second traversal.
- **Determinism.** The same request must produce byte-identical output across
  processes. No `Math.random()`, no `Date.now()`, no iteration over an unordered
  `Set`/object in a generation path. Randomness comes from `generate/rng.ts`;
  time comes from the injected `options.now`. **Webhook backoff jitter is seeded**
  per design §2.2 — it is not an exception to this rule, it is an application of it.
- **The core is pure.** `src/server/handler.ts` and everything it imports must
  not touch Node APIs. `node:` appears in exactly two files today,
  `server/node.ts` and `server/cli.ts`, and this plan keeps that true.
  `fetch`, `Request`, `Response`, `Headers`, `URL`, `TextEncoder`, and
  `crypto.subtle` are web globals and are all fine.
- **A fixture or LLM miss is never an error.** It falls through to seeded
  generation.
- **Errors stay on-contract.** Emit the operation's declared error schema when
  one exists; fall back to the built-in envelope only when it does not.
- **The mock keeps serving.** Everything this plan adds runs after the response
  exists. Nothing in it may throw in a way that replaces a good response.
- **`zod` is the only hard runtime dependency.** This plan adds none.
- **US English spelling** everywhere — identifiers, test names, comments, docs.
  `honor`, `behavior`, `serialize`, `normalize`, `canceled`.
- **Tests live in `test/` mirroring `src/`**, written in TypeScript, run by
  `node:test`. Write the test first, watch it fail, then implement.
- **No outbound network in the test suite.** Unit tests inject `fetch`;
  integration tests use `captureOnly` or a loopback `node:http` receiver.
- **Shell: one plain command per Bash call, with literal arguments.** No `&&`, no
  pipes, no `$(...)`, no redirects, no heredocs, no `cd`. Multi-paragraph commits
  use repeated `-m` flags. `git push`, `npm publish`, `rm -rf`, and `sudo` are
  denied by policy.

## Verification commands

```sh
npm test                          # whole suite
node --test test/webhooks/        # one directory
npx tsc --noEmit                  # typecheck
```

The suite stands at **509 tests** at the start of this plan, with a clean
typecheck. Both must hold at the end of every task.

## The test-quality bar

Six tests have reached this project's plans that **could not fail**, two of them
during plan 5. Every one was caught by review, never by the plan author. Before
accepting any test that claims to prove a mechanism, **observe it fail by
mutation — and break the exact condition the test targets, not a nearby line.**
Plan 5's dead test survived both its author's and its implementer's mutation runs
because both broke something adjacent.

Five traps are live in this plan specifically, all named in design §6:

| Trap | Why it passes broken | The fix |
|---|---|---|
| Signing asserts the header exists | Any hash produces a header, including a wrong one | Known-answer vector: fixed secret, timestamp, body, precomputed hex |
| Retry asserts "it retried" | A classifier that retries *everything* passes | Assert the attempt count **and** the exact delay sequence |
| Capture asserts `deliveries().length === 1` | True whether or not the payload conformed | Assert the body **validates against the declared schema** |
| Determinism compares a process to itself | Seeded generation makes that trivially true | Compare across a fresh process |
| `unresolved` asserts nothing threw | Every non-throwing bug passes | Assert the specific outcome and reason |

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `src/spec/raw.ts` | `asRecord`, `toParameter`, `toContent` — extracted from `load.ts` so `webhooks.ts` can reuse them without an import cycle. |
| `src/spec/webhooks.ts` | Parse 3.1 top-level `webhooks` and per-operation `callbacks`. |
| `src/webhooks/expr.ts` | The runtime-expression subset and its support check. |
| `src/webhooks/sign.ts` | HMAC-SHA256 via `crypto.subtle`. |
| `src/webhooks/deliver.ts` | One delivery: retry classification, seeded backoff, `fetch`, capture. |
| `src/webhooks/emit.ts` | Destination resolution, payload generation, signing, the delivery log. |
| `test/spec/webhooks.test.ts`, `test/webhooks/expr.test.ts`, `test/webhooks/sign.test.ts`, `test/webhooks/deliver.test.ts`, `test/webhooks/emit.test.ts`, `test/server/webhooks.test.ts`, `test/server/webhooks-loopback.test.ts` | Tests mirroring the above. |

**Modified files**

| File | Change |
|---|---|
| `src/spec/types.ts` | `WebhookSpec`, `CallbackSpec`; `Api.webhooks`; `Operation.callbacks`. |
| `src/spec/load.ts` | Use `raw.ts`; parse webhooks and callbacks. |
| `src/runtime/types.ts` | `EmitCtx`. |
| `src/runtime/config.ts` | `EmitConfig`; `OperationConfig.emits`; `ResolvedConfig.emits`. |
| `src/server/handler.ts` | New options; callback capture and emission at the single exit; `emit`, `deliveries`, `clearDeliveries`, `settled`, `close`. |
| `src/index.ts` | Expose the four new methods; `close()` drains emissions before closing the server. |
| `docs/…/2026-08-12-mockingham-webhooks-design.md`, `docs/superpowers/deferred-items.md` | Task 10. |

---

## Task 1: Load webhooks and callbacks

The document declares both shapes and `loadApi` ignores both today. This task is
pure parsing — no runtime behavior changes.

It opens by extracting three helpers from `load.ts` into `src/spec/raw.ts`.
`webhooks.ts` needs them, and having `webhooks.ts` import from `load.ts` while
`load.ts` imports `webhooks.ts` would be a cycle. The extraction is a move, not a
rewrite: the function bodies are unchanged.

**Files:**
- Create: `src/spec/raw.ts`, `src/spec/webhooks.ts`, `test/spec/webhooks.test.ts`
- Modify: `src/spec/types.ts`, `src/spec/load.ts`

**Interfaces:**
- Consumes: `HTTP_METHODS`, `MediaType`, `Parameter`, `Schema` (`src/spec/types.ts`).
- Produces:
  - `asRecord(value: unknown): Record<string, unknown>`, `toParameter(raw: unknown): Parameter`, `toContent(raw: unknown): Record<string, MediaType>` — all in `src/spec/raw.ts`
  - `interface WebhookSpec { name: string; method: HttpMethod; body?: Record<string, MediaType>; headers: Parameter[] }`
  - `interface CallbackSpec { name: string; expression: string; method: HttpMethod; body?: Record<string, MediaType> }`
  - `toWebhooks(raw: unknown): Record<string, WebhookSpec>`, `toCallbacks(raw: unknown): CallbackSpec[]` — in `src/spec/webhooks.ts`
  - `Api.webhooks: Record<string, WebhookSpec>`, `Operation.callbacks: CallbackSpec[]`

- [ ] **Step 1: Write the failing test**

Create `test/spec/webhooks.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        parameters: [
          { name: 'X-Topic', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'ignored', in: 'query', required: false, schema: { type: 'string' } }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/subscriptions': {
      post: {
        operationId: 'subscribe',
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: {
                requestBody: {
                  content: { 'application/json': { schema: { type: 'object' } } }
                },
                responses: { '200': { description: 'ok' } }
              }
            }
          },
          onOrderCanceled: {
            '{$request.body#/cancelUrl}': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['reason'],
                        properties: { reason: { type: 'string' } }
                      }
                    }
                  }
                },
                responses: { '200': { description: 'ok' } }
              }
            }
          }
        }
      }
    },
    '/plain': { get: { operationId: 'plain', responses: { '200': { description: 'ok' } } } }
  }
}

const api = loadApi(doc)
const find = (id: string) => api.operations.find((op) => op.operationId === id)!

test('a top-level webhook is parsed with its method and body schema', () => {
  const hook = api.webhooks['onOrderShipped']!
  assert.equal(hook.name, 'onOrderShipped')
  assert.equal(hook.method, 'post')
  assert.deepEqual(hook.body?.['application/json']?.schema.required, ['orderId'])
})

test('only header parameters are kept on a webhook', () => {
  // The others cannot travel on an outbound request the mock originates.
  const hook = api.webhooks['onOrderShipped']!
  assert.deepEqual(hook.headers.map((p) => p.name), ['X-Topic'])
})

test('callbacks are parsed with the expression preserved as text', () => {
  // The expression can only be resolved against a live request, so it stays
  // text here rather than being compiled at load time.
  const callbacks = find('subscribe').callbacks
  assert.equal(callbacks.length, 2)
  const shipped = callbacks.find((c) => c.name === 'onOrderShipped')!
  assert.equal(shipped.expression, '{$request.body#/callbackUrl}')
  assert.equal(shipped.method, 'post')
})

test('an operation declaring no callbacks gets an empty list, not undefined', () => {
  assert.deepEqual(find('plain').callbacks, [])
})

test('a callback contributes a webhook entry under its own name', () => {
  // So emit() has exactly one place to look for a payload schema.
  const canceled = api.webhooks['onOrderCanceled']!
  assert.equal(canceled.name, 'onOrderCanceled')
  assert.deepEqual(canceled.body?.['application/json']?.schema.required, ['reason'])
})

test('a top-level webhook wins a name collision with a callback', () => {
  // onOrderShipped is declared both ways; the top-level declaration is the
  // document's more explicit one, and its schema requires orderId.
  assert.deepEqual(
    api.webhooks['onOrderShipped']?.body?.['application/json']?.schema.required,
    ['orderId']
  )
})

test('a document declaring neither yields an empty webhook map', () => {
  const bare = loadApi({ openapi: '3.1.0', paths: {} })
  assert.deepEqual(bare.webhooks, {})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/spec/webhooks.test.ts`

Expected: FAIL — `api.webhooks` is `undefined`.

- [ ] **Step 3: Extract the shared raw-parsing helpers**

Create `src/spec/raw.ts` by MOVING three functions out of `src/spec/load.ts`
unchanged:

```ts
import type { MediaType, Parameter, Schema } from './types.ts'

/**
 * Shared by `load.ts` and `webhooks.ts`. They live here rather than in
 * `load.ts` because `load.ts` calls into `webhooks.ts`, and importing back the
 * other way would be a cycle.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

export function toParameter(raw: unknown): Parameter {
  const record = asRecord(raw)
  return {
    name: String(record['name'] ?? ''),
    location: (record['in'] ?? 'query') as Parameter['location'],
    required: record['required'] === true,
    schema: asRecord(record['schema']) as Schema
  }
}

export function toContent(raw: unknown): Record<string, MediaType> {
  const out: Record<string, MediaType> = {}
  for (const [mediaType, value] of Object.entries(asRecord(raw))) {
    const record = asRecord(value)
    out[mediaType] = {
      schema: asRecord(record['schema']) as Schema,
      example: record['example'],
      examples: record['examples'] as MediaType['examples']
    }
  }
  return out
}
```

Delete those three from `load.ts` and import them instead:

```ts
import { asRecord, toContent, toParameter } from './raw.ts'
```

- [ ] **Step 4: Add the types**

In `src/spec/types.ts`:

```ts
/**
 * One outbound request the document says the API can make — a 3.1 top-level
 * `webhooks` entry, or a per-operation `callbacks` entry contributing its
 * payload schema under its own name.
 */
export interface WebhookSpec {
  name: string
  method: HttpMethod
  body?: Record<string, MediaType>
  /** Header parameters only; nothing else can travel on an outbound request. */
  headers: Parameter[]
}

/**
 * A per-operation `callbacks` entry. `expression` is the OpenAPI runtime
 * expression exactly as written — it can only be resolved against a live
 * request, so it stays text until then.
 */
export interface CallbackSpec {
  name: string
  expression: string
  method: HttpMethod
  body?: Record<string, MediaType>
}
```

Add `callbacks: CallbackSpec[]` to `Operation`, and `webhooks: Record<string, WebhookSpec>` to `Api`.

- [ ] **Step 5: Write the parsers**

Create `src/spec/webhooks.ts`:

```ts
import { HTTP_METHODS } from './types.ts'
import { asRecord, toContent, toParameter } from './raw.ts'
import type { CallbackSpec, HttpMethod, WebhookSpec } from './types.ts'

/**
 * 3.1's top-level `webhooks`: a map of name to path item. Each entry is ONE
 * outbound request. A path item declaring several methods is unusual; the
 * first in `HTTP_METHODS` order wins, so the choice is stable rather than
 * dependent on key order in the source document — invariant 2 forbids letting
 * an unordered iteration decide anything observable.
 */
export function toWebhooks(raw: unknown): Record<string, WebhookSpec> {
  const out: Record<string, WebhookSpec> = {}
  for (const [name, rawItem] of Object.entries(asRecord(raw))) {
    const item = asRecord(rawItem)
    for (const method of HTTP_METHODS) {
      const rawOp = item[method]
      if (rawOp === undefined) continue
      const op = asRecord(rawOp)
      const declared = Array.isArray(op['parameters'])
        ? (op['parameters'] as unknown[]).map(toParameter)
        : []
      out[name] = {
        name,
        method: method as HttpMethod,
        body: op['requestBody']
          ? toContent(asRecord(op['requestBody'])['content'])
          : undefined,
        headers: declared.filter((parameter) => parameter.location === 'header')
      }
      break
    }
  }
  return out
}

/** One operation's `callbacks`: name → runtime expression → path item. */
export function toCallbacks(raw: unknown): CallbackSpec[] {
  const out: CallbackSpec[] = []
  for (const [name, rawEntry] of Object.entries(asRecord(raw))) {
    for (const [expression, rawItem] of Object.entries(asRecord(rawEntry))) {
      const item = asRecord(rawItem)
      for (const method of HTTP_METHODS) {
        const rawOp = item[method]
        if (rawOp === undefined) continue
        out.push({
          name,
          expression,
          method: method as HttpMethod,
          body: asRecord(rawOp)['requestBody']
            ? toContent(asRecord(asRecord(rawOp)['requestBody'])['content'])
            : undefined
        })
        break
      }
    }
  }
  return out
}
```

- [ ] **Step 6: Wire them into `loadApi`**

In `src/spec/load.ts`, import `{ toCallbacks, toWebhooks }` from `./webhooks.ts`.
Add `callbacks: toCallbacks(op['callbacks'])` to the pushed operation object.
Then, before the `return`:

```ts
  const webhooks = toWebhooks(resolved['webhooks'])
  // A callback contributes its payload schema under its own name, so `emit()`
  // has one place to look rather than two. A top-level `webhooks` entry wins a
  // collision: it is the document's more explicit declaration of the same event.
  for (const operation of operations) {
    for (const callback of operation.callbacks) {
      if (webhooks[callback.name] !== undefined) continue
      webhooks[callback.name] = {
        name: callback.name,
        method: callback.method,
        body: callback.body,
        headers: []
      }
    }
  }

  return { version, operations, schemaNames, securitySchemes, webhooks }
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/spec/webhooks.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS. Existing `loadApi` tests must be unaffected — the helper
extraction is a move, not a rewrite. If one fails, the move changed behavior.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 9: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: load webhooks and callbacks from the document' -m 'Parses 3.1 top-level webhooks and per-operation callbacks. A callback contributes its payload schema under its own name so emit() has one lookup; a top-level webhook wins a name collision.' -m 'Extracts asRecord, toParameter, and toContent into spec/raw.ts so the webhook parser can reuse them without an import cycle back through load.ts.'
```

---

## Task 2: Runtime expression resolution

Destination tier 2 — the "client POSTs its own callback URL" flow — needs the
document's runtime expressions evaluated against a live request.

**Files:**
- Create: `src/webhooks/expr.ts`, `test/webhooks/expr.test.ts`

**Interfaces:**
- Produces:
  - `interface ExprInput { request: Request; url: URL; method: string; params: Record<string, string>; body: unknown; result?: { status: number; headers: Record<string, string>; body: unknown } }`
  - `type ExprResult = { ok: true; value: string } | { ok: false; reason: string }`
  - `isSupported(expression: string): boolean`
  - `resolveExpression(expression: string, input: ExprInput): ExprResult`

- [ ] **Step 1: Write the failing test**

Create `test/webhooks/expr.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupported, resolveExpression } from '../../src/webhooks/expr.ts'
import type { ExprInput } from '../../src/webhooks/expr.ts'

function inputFor(overrides: Partial<ExprInput> = {}): ExprInput {
  const request = new Request('http://mock/subs?tenant=acme', {
    method: 'POST',
    headers: { 'x-cb': 'http://hooks.test/x' }
  })
  return {
    request,
    url: new URL(request.url),
    method: 'POST',
    params: { id: '42' },
    body: { callbackUrl: 'http://hooks.test/orders', nested: { deep: 'yes' }, n: 7 },
    ...overrides
  }
}

test('resolves a whole-expression template', () => {
  const out = resolveExpression('{$request.body#/callbackUrl}', inputFor())
  assert.deepEqual(out, { ok: true, value: 'http://hooks.test/orders' })
})

test('resolves a mixed template of literal text and expressions', () => {
  // A document may write a base from the body and a fixed path after it.
  const out = resolveExpression('{$request.body#/callbackUrl}/ack/{$request.path.id}', inputFor())
  assert.deepEqual(out, { ok: true, value: 'http://hooks.test/orders/ack/42' })
})

test('resolves headers case-insensitively, query, path, url, and method', () => {
  const input = inputFor()
  assert.equal(resolveExpression('{$request.header.X-CB}', input).ok && resolveExpression('{$request.header.X-CB}', input).value, 'http://hooks.test/x')
  assert.deepEqual(resolveExpression('{$request.query.tenant}', input), { ok: true, value: 'acme' })
  assert.deepEqual(resolveExpression('{$request.path.id}', input), { ok: true, value: '42' })
  assert.deepEqual(resolveExpression('{$method}', input), { ok: true, value: 'POST' })
  assert.deepEqual(resolveExpression('{$url}', input), { ok: true, value: 'http://mock/subs?tenant=acme' })
})

test('resolves a nested json pointer and coerces a number', () => {
  assert.deepEqual(
    resolveExpression('{$request.body#/nested/deep}', inputFor()),
    { ok: true, value: 'yes' }
  )
  assert.deepEqual(resolveExpression('{$request.body#/n}', inputFor()), { ok: true, value: '7' })
})

test('decodes json pointer escapes', () => {
  const input = inputFor({ body: { 'a/b': 'slash', 'c~d': 'tilde' } })
  assert.deepEqual(resolveExpression('{$request.body#/a~1b}', input), { ok: true, value: 'slash' })
  assert.deepEqual(resolveExpression('{$request.body#/c~0d}', input), { ok: true, value: 'tilde' })
})

test('resolves $response.* and $statusCode when a result is present', () => {
  const input = inputFor({
    result: { status: 201, headers: { location: '/orders/9' }, body: { id: 'o_1' } }
  })
  assert.deepEqual(resolveExpression('{$statusCode}', input), { ok: true, value: '201' })
  assert.deepEqual(resolveExpression('{$response.header.location}', input), { ok: true, value: '/orders/9' })
  assert.deepEqual(resolveExpression('{$response.body#/id}', input), { ok: true, value: 'o_1' })
})

test('a $response expression with no result fails rather than resolving empty', () => {
  // Capture happens at request time for some callers; silently producing '' would
  // hand delivery a malformed URL instead of falling through to the next tier.
  const out = resolveExpression('{$response.body#/id}', inputFor())
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.reason, '$response.body#/id')
})

test('a missing pointer target fails with the offending token as the reason', () => {
  const out = resolveExpression('{$request.body#/nope}', inputFor())
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.reason, '$request.body#/nope')
})

test('a non-scalar pointer target fails rather than stringifying an object', () => {
  const out = resolveExpression('{$request.body#/nested}', inputFor())
  assert.equal(out.ok, false)
})

test('isSupported accepts the documented subset', () => {
  for (const expression of [
    '{$url}', '{$method}', '{$statusCode}',
    '{$request.header.x}', '{$request.query.x}', '{$request.path.x}',
    '{$request.body}', '{$request.body#/a/b}',
    '{$response.header.x}', '{$response.body#/a}',
    'http://fixed.test/hook'
  ]) {
    assert.equal(isSupported(expression), true, expression)
  }
})

test('isSupported rejects anything outside it', () => {
  for (const expression of [
    '{$request.cookie.x}', '{$response.query.x}', '{$response.path.x}',
    '{$nonsense}', '{$request.}', '{$request.header.}'
  ]) {
    assert.equal(isSupported(expression), false, expression)
  }
})

test('isSupported is about form, not resolvability', () => {
  // A well-formed expression that happens to point at nothing is still
  // supported; it fails at resolution, which is a different tier of the
  // destination fallback.
  assert.equal(isSupported('{$request.body#/absent}'), true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/webhooks/expr.test.ts`

Expected: FAIL — cannot find module `src/webhooks/expr.ts`.

- [ ] **Step 3: Implement**

Create `src/webhooks/expr.ts`:

```ts
/**
 * OpenAPI runtime expressions, restricted to the subset the master spec §13
 * documents: `$url`, `$method`, `$statusCode`,
 * `$request.{header|query|path}.name`, `$request.body#/pointer`, and the
 * `$response` equivalents that make sense for a response — `header` and `body`.
 * `$response.query` and `$response.path` are not meaningful and are rejected.
 *
 * An expression may be a whole template or mixed with literal text, because a
 * document can write `{$request.body#/host}/hooks`.
 */

export interface ExprInput {
  request: Request
  url: URL
  method: string
  params: Record<string, string>
  body: unknown
  /** Absent when resolving before a response exists. */
  result?: { status: number; headers: Record<string, string>; body: unknown }
}

export type ExprResult =
  | { ok: true; value: string }
  | { ok: false; reason: string }

const TOKEN = /\{([^}]*)\}/g

/**
 * A local JSON-pointer walk rather than reuse of `spec/refs.ts`. That module
 * resolves `$ref` inside a document and carries cycle tracking this does not
 * need; coupling the webhook path to it for eight lines would be the worse
 * trade, the same call made for `split()` in `deferred-items.md`.
 */
function resolvePointer(source: unknown, pointer: string): unknown {
  if (pointer === '') return source
  let value = source
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined
}

function resolveToken(token: string, input: ExprInput): string | undefined {
  if (token === '$url') return input.url.href
  if (token === '$method') return input.method
  if (token === '$statusCode') {
    return input.result === undefined ? undefined : String(input.result.status)
  }

  const isRequest = token.startsWith('$request.')
  const isResponse = token.startsWith('$response.')
  if (!isRequest && !isResponse) return undefined
  const rest = token.slice((isRequest ? '$request.' : '$response.').length)

  if (rest.startsWith('header.')) {
    const name = rest.slice('header.'.length).toLowerCase()
    if (name === '') return undefined
    if (isRequest) return input.request.headers.get(name) ?? undefined
    return input.result?.headers[name]
  }
  if (isRequest && rest.startsWith('query.')) {
    return input.url.searchParams.get(rest.slice('query.'.length)) ?? undefined
  }
  if (isRequest && rest.startsWith('path.')) {
    return input.params[rest.slice('path.'.length)]
  }
  if (rest === 'body' || rest.startsWith('body#')) {
    const source = isRequest ? input.body : input.result?.body
    if (source === undefined) return undefined
    const pointer = rest === 'body' ? '' : rest.slice('body#'.length)
    return scalar(resolvePointer(source, pointer))
  }
  return undefined
}

function isSupportedToken(token: string): boolean {
  if (token === '$url' || token === '$method' || token === '$statusCode') return true
  const isRequest = token.startsWith('$request.')
  const isResponse = token.startsWith('$response.')
  if (!isRequest && !isResponse) return false
  const rest = token.slice((isRequest ? '$request.' : '$response.').length)
  if (rest.startsWith('header.')) return rest.length > 'header.'.length
  if (isRequest && rest.startsWith('query.')) return rest.length > 'query.'.length
  if (isRequest && rest.startsWith('path.')) return rest.length > 'path.'.length
  return rest === 'body' || rest.startsWith('body#')
}

/**
 * Whether every token in the template is a FORM this implementation supports.
 * Deliberately not about whether it resolves: an unsupported form is a startup
 * warning, while a supported form that finds nothing is a runtime fall-through
 * to the next destination tier.
 */
export function isSupported(expression: string): boolean {
  for (const match of expression.matchAll(TOKEN)) {
    if (!isSupportedToken((match[1] ?? '').trim())) return false
  }
  return true
}

export function resolveExpression(expression: string, input: ExprInput): ExprResult {
  let failed: string | undefined
  const value = expression.replace(TOKEN, (_, raw: string) => {
    const token = raw.trim()
    const resolved = resolveToken(token, input)
    if (resolved === undefined) {
      failed ??= token
      return ''
    }
    return resolved
  })
  if (failed !== undefined) return { ok: false, reason: failed }
  return { ok: true, value }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/webhooks/expr.test.ts`

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: resolve OpenAPI runtime expressions' -m 'The documented subset only, over whole or mixed templates. isSupported checks form so an unsupported expression can warn at startup, while a supported one that resolves to nothing falls through to the next destination tier at runtime.'
```

---

## Task 3: HMAC signing

Design §2.1: `crypto.subtle`, not `node:crypto`, because emission is reachable
from `handler.ts` and invariant 3 binds everything it imports.

**Files:**
- Create: `src/webhooks/sign.ts`, `test/webhooks/sign.test.ts`

**Interfaces:**
- Produces:
  - `const SIGNATURE_HEADER = 'x-mockingham-signature'`
  - `interface Signature { header: string; timestamp: number; hex: string }`
  - `sign(secret: string, body: string, timestamp: number): Promise<Signature>`

- [ ] **Step 1: Write the failing test**

Create `test/webhooks/sign.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SIGNATURE_HEADER, sign } from '../../src/webhooks/sign.ts'

// A KNOWN-ANSWER VECTOR, computed independently with WebCrypto. A test that
// only asserts a signature header exists passes against any hash, including a
// wrong one — which is the whole failure mode this vector rules out. The signed
// string is `${timestamp}.${body}`, here `1700000000.{"id":"o_1"}`.
const SECRET = 'topsecret'
const BODY = '{"id":"o_1"}'
const TIMESTAMP = 1_700_000_000
const EXPECTED = 'd59acd89488c9c1f46acbddca01afef5b53dcff2e5277aa939c3461939be60cc'

test('sign matches the known-answer vector', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.equal(signature.hex, EXPECTED)
})

test('the header carries the timestamp and the v1 signature', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.equal(signature.header, `t=${TIMESTAMP},v1=${EXPECTED}`)
  assert.equal(signature.timestamp, TIMESTAMP)
})

test('SIGNATURE_HEADER is the documented name', () => {
  assert.equal(SIGNATURE_HEADER, 'x-mockingham-signature')
})

test('the timestamp is part of what is signed', async () => {
  // Otherwise a captured signature could be replayed against a new timestamp.
  const other = await sign(SECRET, BODY, TIMESTAMP + 1)
  assert.notEqual(other.hex, EXPECTED)
})

test('a different secret produces a different signature', async () => {
  const other = await sign('other', BODY, TIMESTAMP)
  assert.notEqual(other.hex, EXPECTED)
})

test('a different body produces a different signature', async () => {
  const other = await sign(SECRET, '{"id":"o_2"}', TIMESTAMP)
  assert.notEqual(other.hex, EXPECTED)
})

test('the hex is 64 lowercase characters', async () => {
  const signature = await sign(SECRET, BODY, TIMESTAMP)
  assert.match(signature.hex, /^[0-9a-f]{64}$/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/webhooks/sign.test.ts`

Expected: FAIL — cannot find module `src/webhooks/sign.ts`.

- [ ] **Step 3: Implement**

Create `src/webhooks/sign.ts`:

```ts
/**
 * HMAC-SHA256 over `timestamp + '.' + rawBody`, per master spec §13.
 *
 * `crypto.subtle` rather than `node:crypto` — see the webhooks design §2.1.
 * Emission is reachable from `src/server/handler.ts`, and invariant 3 says the
 * handler and everything it imports must not touch Node APIs. `crypto.subtle`
 * is a web global like `Request` and `TextEncoder`, which the core already
 * depends on. It is async, which costs nothing because delivery already is.
 *
 * This exists so the client's signature-verification path — the
 * security-critical one — is exercised before production rather than after.
 */

export const SIGNATURE_HEADER = 'x-mockingham-signature'

export interface Signature {
  /** The full header value: `t=<timestamp>,v1=<hex>`. */
  header: string
  timestamp: number
  hex: string
}

const encoder = new TextEncoder()

export async function sign(
  secret: string,
  body: string,
  timestamp: number
): Promise<Signature> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return { header: `t=${timestamp},v1=${hex}`, timestamp, hex }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/webhooks/sign.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Confirm the vector is load-bearing**

Change `${timestamp}.${body}` to `${body}` in `sign.ts`, run the file, and
confirm `sign matches the known-answer vector` fails with a concrete hex
mismatch. Restore it. **Report the exact failure message.** This is the
observation that separates a real signature test from one that merely checks a
header exists.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: sign webhook payloads with HMAC-SHA256' -m 'Uses the crypto.subtle web global rather than node:crypto, because emission is reachable from handler.ts and the pure core must stay free of Node APIs. Header format and signed string are unchanged from master spec section 13.' -m 'Tested against a known-answer vector rather than by asserting a header exists, which would pass against any hash.'
```

---

## Task 4: Delivery with retry and seeded backoff

**Files:**
- Create: `src/webhooks/deliver.ts`, `test/webhooks/deliver.test.ts`

**Interfaces:**
- Consumes: `createRng` (`src/generate/rng.ts`).
- Produces:
  - `type DeliveryOutcome = 'delivered' | 'failed' | 'captured' | 'unresolved'`
  - `interface Delivery { webhook: string; url?: string; body: string; headers: Record<string, string>; outcome: DeliveryOutcome; status?: number; attempts: number; error?: string }`
  - `interface RetryConfig { attempts?: number; backoff?: 'exponential'; baseMs?: number; maxDelayMs?: number }`
  - `interface ResolvedRetry { attempts: number; baseMs: number; maxDelayMs: number }`
  - `resolveRetry(config?: RetryConfig): ResolvedRetry`
  - `shouldRetry(status: number): boolean`
  - `backoffFor(input: { seed: string; webhook: string; attempt: number; retry: ResolvedRetry }): number`
  - `deliver(input: DeliverInput): Promise<Delivery>` where
    `interface DeliverInput { webhook: string; url?: string; body: string; headers: Record<string, string>; captureOnly: boolean; retry: ResolvedRetry; seed: string; fetch: typeof fetch; sleep: (ms: number) => Promise<void> }`

- [ ] **Step 1: Write the failing test**

Create `test/webhooks/deliver.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backoffFor, deliver, resolveRetry, shouldRetry
} from '../../src/webhooks/deliver.ts'

const retry = resolveRetry({ attempts: 3, baseMs: 250, maxDelayMs: 10_000 })

function harness(responses: Array<Response | Error>) {
  const slept: number[] = []
  const urls: string[] = []
  let call = 0
  const fetchStub = (async (input: Request | string) => {
    urls.push(typeof input === 'string' ? input : input.url)
    const next = responses[Math.min(call++, responses.length - 1)]!
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { slept, urls, fetch: fetchStub, sleep: async (ms: number) => { slept.push(ms) } }
}

const base = {
  webhook: 'onOrderShipped',
  url: 'http://hooks.test/x',
  body: '{"id":1}',
  headers: { 'content-type': 'application/json' },
  captureOnly: false,
  retry,
  seed: 'plan6'
}

test('resolveRetry fills the documented defaults', () => {
  assert.deepEqual(resolveRetry(), { attempts: 3, baseMs: 250, maxDelayMs: 10_000 })
})

test('shouldRetry covers 5xx, 408, and 429 only', () => {
  for (const status of [500, 502, 503, 408, 429]) {
    assert.equal(shouldRetry(status), true, String(status))
  }
  for (const status of [200, 201, 400, 401, 403, 404, 422]) {
    assert.equal(shouldRetry(status), false, String(status))
  }
})

test('backoff is deterministic, seeded, and capped', () => {
  const first = backoffFor({ seed: 'plan6', webhook: 'w', attempt: 0, retry })
  assert.equal(first, backoffFor({ seed: 'plan6', webhook: 'w', attempt: 0, retry }))
  assert.notEqual(first, backoffFor({ seed: 'plan6', webhook: 'w', attempt: 1, retry }))
  assert.notEqual(first, backoffFor({ seed: 'other', webhook: 'w', attempt: 0, retry }))
  // Jittered into [50%, 100%] of the doubling base, and never past the cap.
  assert.ok(first >= 125 && first <= 250, String(first))
  const late = backoffFor({ seed: 'plan6', webhook: 'w', attempt: 20, retry })
  assert.ok(late >= 5_000 && late <= 10_000, String(late))
})

test('a 2xx delivers on the first attempt with no sleeping', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.status, 200)
  assert.equal(delivery.attempts, 1)
  assert.deepEqual(h.slept, [])
})

test('a 500 retries to the attempt limit, sleeping the exact seeded sequence', async () => {
  // Asserting "it retried" would pass against a classifier that retries
  // everything, and asserting a sleep happened would pass against a constant
  // delay. Both the count and the sequence are pinned.
  const h = harness([new Response('', { status: 500 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })

  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, 500)
  assert.equal(delivery.attempts, 3)
  assert.deepEqual(h.slept, [
    backoffFor({ seed: 'plan6', webhook: 'onOrderShipped', attempt: 0, retry }),
    backoffFor({ seed: 'plan6', webhook: 'onOrderShipped', attempt: 1, retry })
  ])
})

test('a 404 does not retry', async () => {
  const h = harness([new Response('', { status: 404 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, 404)
  assert.equal(delivery.attempts, 1)
  assert.deepEqual(h.slept, [])
})

test('a network error retries and is reported', async () => {
  const h = harness([new Error('econnrefused'), new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.attempts, 2)
  assert.equal(h.slept.length, 1)
})

test('an exhausted network failure reports the error and no status', async () => {
  const h = harness([new Error('econnrefused')])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'failed')
  assert.equal(delivery.status, undefined)
  assert.equal(delivery.error, 'econnrefused')
  assert.equal(delivery.attempts, 3)
})

test('captureOnly never calls fetch', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, captureOnly: true, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'captured')
  assert.equal(delivery.attempts, 0)
  assert.deepEqual(h.urls, [])
})

test('an absent url is unresolved and never calls fetch', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, url: undefined, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.outcome, 'unresolved')
  assert.equal(delivery.attempts, 0)
  assert.equal(delivery.status, undefined)
  assert.deepEqual(h.urls, [])
})

test('the delivery carries the body and headers it was given', async () => {
  const h = harness([new Response('', { status: 200 })])
  const delivery = await deliver({ ...base, fetch: h.fetch, sleep: h.sleep })
  assert.equal(delivery.body, '{"id":1}')
  assert.deepEqual(delivery.headers, { 'content-type': 'application/json' })
  assert.equal(delivery.webhook, 'onOrderShipped')
  assert.equal(delivery.url, 'http://hooks.test/x')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/webhooks/deliver.test.ts`

Expected: FAIL — cannot find module `src/webhooks/deliver.ts`.

- [ ] **Step 3: Implement**

Create `src/webhooks/deliver.ts`:

```ts
import { createRng } from '../generate/rng.ts'

export type DeliveryOutcome = 'delivered' | 'failed' | 'captured' | 'unresolved'

/**
 * One outbound attempt's record. `emit()` resolves with this rather than
 * rejecting in every case, including `unresolved` and an exhausted retry —
 * master spec §13's "an emit never hard-fails" is a property of the return
 * type, not merely of the implementation.
 */
export interface Delivery {
  webhook: string
  /** Absent when nothing resolved a destination. */
  url?: string
  /** The serialized payload, exactly as sent and as signed. */
  body: string
  headers: Record<string, string>
  outcome: DeliveryOutcome
  /** Absent for `unresolved`, `captured`, and a network-level failure. */
  status?: number
  attempts: number
  error?: string
}

export interface RetryConfig {
  attempts?: number
  /** Only `'exponential'`; §13 names no other strategy. */
  backoff?: 'exponential'
  baseMs?: number
  maxDelayMs?: number
}

export interface ResolvedRetry {
  attempts: number
  baseMs: number
  maxDelayMs: number
}

export function resolveRetry(config: RetryConfig = {}): ResolvedRetry {
  return {
    attempts: config.attempts ?? 3,
    // §13's retry block never names a base delay, which would leave the
    // doubling sequence undefined. See the webhooks design §2.2.
    baseMs: config.baseMs ?? 250,
    maxDelayMs: config.maxDelayMs ?? 10_000
  }
}

/**
 * Design §2.5, stated precisely because §13's two sentences narrow each other
 * and admit two implementations: retry a 5xx, a 408, and a 429; do not retry
 * any other 4xx or any 2xx. A 3xx never reaches here — `fetch` follows
 * redirects itself.
 */
export function shouldRetry(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/**
 * Seeded jitter, keyed by webhook and attempt — design §2.2. Invariant 2
 * forbids `Math.random()`, and keying by attempt rather than advancing one
 * stream means a delivery's delays do not depend on how many other deliveries
 * came first. That is what keeps a run replayable and a failing test
 * reproducible.
 */
export function backoffFor(input: {
  seed: string
  webhook: string
  attempt: number
  retry: ResolvedRetry
}): number {
  const rng = createRng(`${input.seed}|webhook|${input.webhook}|${input.attempt}`)
  const base = Math.min(input.retry.baseMs * 2 ** input.attempt, input.retry.maxDelayMs)
  return Math.round(base * (0.5 + rng.next() * 0.5))
}

export interface DeliverInput {
  webhook: string
  url?: string
  body: string
  headers: Record<string, string>
  captureOnly: boolean
  retry: ResolvedRetry
  seed: string
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
}

export async function deliver(input: DeliverInput): Promise<Delivery> {
  const record: Delivery = {
    webhook: input.webhook,
    url: input.url,
    body: input.body,
    headers: input.headers,
    outcome: 'unresolved',
    attempts: 0
  }

  if (input.url === undefined) return record
  if (input.captureOnly) return { ...record, outcome: 'captured' }

  let lastError: string | undefined
  let lastStatus: number | undefined

  for (let attempt = 0; attempt < input.retry.attempts; attempt++) {
    record.attempts = attempt + 1
    let status: number | undefined
    try {
      const response = await input.fetch(input.url, {
        method: 'POST',
        headers: input.headers,
        body: input.body
      })
      status = response.status
      lastStatus = status
      lastError = undefined
      if (response.ok) {
        return { ...record, outcome: 'delivered', status }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      lastStatus = undefined
    }

    const retryable = status === undefined || shouldRetry(status)
    const remaining = attempt < input.retry.attempts - 1
    if (!retryable || !remaining) break
    await input.sleep(backoffFor({ ...input, attempt }))
  }

  return { ...record, outcome: 'failed', status: lastStatus, error: lastError }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/webhooks/deliver.test.ts`

Expected: PASS, 11 tests.

- [ ] **Step 5: Confirm the retry test is load-bearing**

Change `shouldRetry` to `return true`, run the file, and confirm
`a 404 does not retry` fails on the attempt count. Restore it. Then change
`backoffFor` to `return 100`, run again, and confirm the 500 test fails on the
delay sequence. Restore. **Report both failure messages** — they are what
separate this from a test that merely observes that a retry happened.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: deliver webhooks with retry and seeded backoff' -m 'Retries a 5xx, 408, 429, and a network error; never retries another 4xx. Backoff jitter comes from the seeded PRNG keyed by webhook and attempt, so a delivery replays identically and a failing test reproduces.' -m 'captureOnly and an unresolved destination both short-circuit before fetch, so neither can reach the network.'
```

---

## Task 5: Emission — destination, payload, signature

The composition layer. Everything before it is a leaf; this is where a webhook
name becomes a signed, addressed, schema-conforming request.

**Files:**
- Create: `src/webhooks/emit.ts`, `test/webhooks/emit.test.ts`

**Interfaces:**
- Consumes: `deliver`, `Delivery`, `resolveRetry`, `ResolvedRetry`, `RetryConfig` (Task 4); `sign`, `SIGNATURE_HEADER` (Task 3); `generateValue`, `GenerateOptions` (`src/generate/generate.ts`); `applyOverrides` (`src/resolve/layer.ts`); `createRng` (`src/generate/rng.ts`); `Store` (`src/runtime/store.ts`); `Api`, `WebhookSpec` (`src/spec/types.ts`); `OverrideNode` (`src/runtime/types.ts`).
- Produces:
  - `interface WebhookConfig { url?: string; secret?: string; retry?: RetryConfig; headers?: Record<string, string> }`
  - `interface ResolvedWebhook { url?: string; secret?: string; retry: ResolvedRetry; headers: Record<string, string> }`
  - `resolveWebhook(config?: WebhookConfig): ResolvedWebhook`
  - `callbackKey(name: string): string`
  - `MAX_DELIVERIES = 1000`
  - `interface DeliveryLog { record(delivery: Delivery): void; all(): Delivery[]; clear(): void }`
  - `createDeliveryLog(max?: number): DeliveryLog`
  - `emitWebhook(input: EmitInput): Promise<Delivery>`

- [ ] **Step 1: Write the failing test**

Create `test/webhooks/emit.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApi } from '../../src/spec/load.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import { createRng } from '../../src/generate/rng.ts'
import {
  callbackKey, createDeliveryLog, emitWebhook, resolveWebhook
} from '../../src/webhooks/emit.ts'

const api = loadApi({
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId', 'status'],
                properties: {
                  orderId: { type: 'string' },
                  status: { type: 'string' }
                }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {}
})

function harness(status = 200) {
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const fetchStub = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      body: String(init.body),
      headers: init.headers as Record<string, string>
    })
    return new Response('', { status })
  }) as unknown as typeof fetch
  return { sent, fetch: fetchStub, sleep: async () => {} }
}

const baseInput = {
  api,
  captureOnly: false,
  seed: 'plan6',
  generateOptions: { schemaNames: api.schemaNames },
  now: () => 1_700_000_000
}

test('an unknown webhook name throws, like every other target typo', async () => {
  const h = harness()
  await assert.rejects(
    emitWebhook({
      ...baseInput, name: 'nope', config: resolveWebhook(),
      store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
    }),
    /nope/
  )
})

test('the payload is generated from the declared schema', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const body = JSON.parse(delivery.body) as Record<string, unknown>
  assert.equal(typeof body['orderId'], 'string')
  assert.equal(typeof body['status'], 'string')
  assert.equal(delivery.outcome, 'delivered')
})

test('a body override layers over the generated payload', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    bodyOverride: { orderId: 'o_1' },
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const body = JSON.parse(delivery.body) as Record<string, unknown>
  assert.equal(body['orderId'], 'o_1')
  // The un-overridden property still comes from generation.
  assert.equal(typeof body['status'], 'string')
})

test('destination precedence: to beats a captured url beats config', async () => {
  const store = createMemoryStore()
  await store.set(callbackKey('onOrderShipped'), 'http://captured.test/x')
  const config = resolveWebhook({ url: 'http://config.test/x' })

  const first = harness()
  const withTo = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config, to: 'http://explicit.test/x',
    store, rng: createRng('t'), fetch: first.fetch, sleep: first.sleep
  })
  assert.equal(withTo.url, 'http://explicit.test/x')

  const second = harness()
  const withCapture = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config,
    store, rng: createRng('t'), fetch: second.fetch, sleep: second.sleep
  })
  assert.equal(withCapture.url, 'http://captured.test/x')

  const third = harness()
  const withConfig = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config,
    store: createMemoryStore(), rng: createRng('t'), fetch: third.fetch, sleep: third.sleep
  })
  assert.equal(withConfig.url, 'http://config.test/x')
})

test('nothing resolving is unresolved, not an error', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped', config: resolveWebhook(),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.outcome, 'unresolved')
  assert.equal(delivery.url, undefined)
  assert.deepEqual(h.sent, [])
})

test('a secret adds the signature header over the exact body sent', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput,
    name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x', secret: 'topsecret' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  const header = delivery.headers['x-mockingham-signature']
  assert.ok(header, 'signature header missing')
  assert.match(header, /^t=1700000000,v1=[0-9a-f]{64}$/)
  // The signature must cover the body that was actually transmitted.
  assert.equal(h.sent[0]?.body, delivery.body)
})

test('no secret means no signature header', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.headers['x-mockingham-signature'], undefined)
})

test('configured headers travel with the delivery', async () => {
  const h = harness()
  const delivery = await emitWebhook({
    ...baseInput, name: 'onOrderShipped',
    config: resolveWebhook({ url: 'http://hooks.test/x', headers: { 'x-source': 'mockingham' } }),
    store: createMemoryStore(), rng: createRng('t'), fetch: h.fetch, sleep: h.sleep
  })
  assert.equal(delivery.headers['x-source'], 'mockingham')
  assert.equal(delivery.headers['content-type'], 'application/json')
})

test('a header parameter declared on the webhook is generated', async () => {
  // The same treatment renderResponse gives spec-declared response headers.
  const withHeader = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onPing: {
        post: {
          parameters: [
            { name: 'X-Topic', in: 'header', required: true, schema: { const: 'orders' } }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    },
    paths: {}
  })
  const h = harness()

  const delivery = await emitWebhook({
    ...baseInput,
    api: withHeader,
    name: 'onPing',
    config: resolveWebhook({ url: 'http://hooks.test/x' }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  assert.equal(delivery.headers['x-topic'], 'orders')
})

test('a configured header beats a declared one of the same name', async () => {
  const withHeader = loadApi({
    openapi: '3.1.0',
    webhooks: {
      onPing: {
        post: {
          parameters: [
            { name: 'X-Topic', in: 'header', required: true, schema: { const: 'orders' } }
          ],
          responses: { '200': { description: 'ok' } }
        }
      }
    },
    paths: {}
  })
  const h = harness()

  const delivery = await emitWebhook({
    ...baseInput,
    api: withHeader,
    name: 'onPing',
    config: resolveWebhook({ url: 'http://hooks.test/x', headers: { 'X-Topic': 'explicit' } }),
    store: createMemoryStore(),
    rng: createRng('t'),
    fetch: h.fetch,
    sleep: h.sleep
  })

  assert.equal(delivery.headers['x-topic'], 'explicit')
})

test('the delivery log is bounded and drops oldest first', () => {
  const log = createDeliveryLog(2)
  const make = (webhook: string) => ({
    webhook, body: '', headers: {}, outcome: 'captured' as const, attempts: 0
  })
  log.record(make('a'))
  log.record(make('b'))
  log.record(make('c'))
  assert.deepEqual(log.all().map((d) => d.webhook), ['b', 'c'])
  log.clear()
  assert.deepEqual(log.all(), [])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/webhooks/emit.test.ts`

Expected: FAIL — cannot find module `src/webhooks/emit.ts`.

- [ ] **Step 3: Implement**

Create `src/webhooks/emit.ts`:

```ts
import { generateValue } from '../generate/generate.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { applyOverrides } from '../resolve/layer.ts'
import type { Rng } from '../generate/rng.ts'
import type { Api } from '../spec/types.ts'
import type { Store } from '../runtime/store.ts'
import type { OverrideNode } from '../runtime/types.ts'
import { deliver, resolveRetry } from './deliver.ts'
import type { Delivery, ResolvedRetry, RetryConfig } from './deliver.ts'
import { SIGNATURE_HEADER, sign } from './sign.ts'

export interface WebhookConfig {
  url?: string
  secret?: string
  retry?: RetryConfig
  headers?: Record<string, string>
}

export interface ResolvedWebhook {
  url?: string
  secret?: string
  retry: ResolvedRetry
  headers: Record<string, string>
}

export function resolveWebhook(config: WebhookConfig = {}): ResolvedWebhook {
  return {
    url: config.url,
    secret: config.secret,
    retry: resolveRetry(config.retry),
    headers: config.headers ?? {}
  }
}

/**
 * Where a callback URL captured from a runtime expression is stored. Exported
 * because the capture side (the request pipeline) WRITES the key this module
 * READS — two independent spellings of one convention drift silently, with both
 * test suites green in isolation. The same reasoning as `failure.ts`'s exported
 * key builders.
 */
export function callbackKey(name: string): string {
  return `callback|${name}`
}

/** Design §2.6. A documented constant rather than a config knob. */
export const MAX_DELIVERIES = 1000

export interface DeliveryLog {
  record(delivery: Delivery): void
  /** Oldest first. */
  all(): Delivery[]
  clear(): void
}

/**
 * In memory rather than in the `Store`: `deliveries()` returns an array, and
 * `Store` has no enumeration primitive. Widening that interface for one caller
 * was rejected when the same trade-off arose for `reset()`. The consequence is
 * documented — retry attempt state is shared when the Store is, the capture log
 * is per-process.
 */
export function createDeliveryLog(max: number = MAX_DELIVERIES): DeliveryLog {
  let entries: Delivery[] = []
  return {
    record(delivery) {
      entries.push(delivery)
      if (entries.length > max) entries = entries.slice(entries.length - max)
    },
    all: () => [...entries],
    clear() {
      entries = []
    }
  }
}

export interface EmitInput {
  name: string
  api: Api
  config: ResolvedWebhook
  store: Store
  captureOnly: boolean
  seed: string
  rng: Rng
  generateOptions: GenerateOptions
  fetch: typeof fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Destination tier 1. */
  to?: string
  /** Layered over the generated payload, exactly as a response body override is. */
  bodyOverride?: OverrideNode
  /** Passed to override functions; an `EmitCtx` for an operation-linked emit. */
  ctx?: unknown
}

/**
 * Resolve a destination, generate and layer a payload, sign it, deliver it.
 *
 * An unknown webhook name THROWS rather than resolving to a failed delivery.
 * §13's "an emit never hard-fails" is about delivery — a name that is not in
 * the document is a typo, and `compileTarget` and `resolveTarget` already fail
 * loudly on those rather than silently never firing.
 */
export async function emitWebhook(input: EmitInput): Promise<Delivery> {
  const spec = input.api.webhooks[input.name]
  if (spec === undefined) {
    throw new Error(
      `mockingham: no webhook named "${input.name}" is declared in the document. ` +
        'Declare it under the top-level `webhooks`, or as an operation `callbacks` entry.'
    )
  }

  // Tier 1 explicit, tier 2 captured, tier 3 config, tier 4 nothing.
  const captured = (await input.store.get(callbackKey(input.name))) as string | undefined
  const url = input.to ?? captured ?? input.config.url

  const schema = spec.body?.['application/json']?.schema
  const generated = schema === undefined
    ? undefined
    : generateValue(schema, input.rng, input.generateOptions)
  const settled = await applyOverrides(generated, input.bodyOverride, input.ctx)
  const body = settled === undefined ? '' : JSON.stringify(settled)

  // Header parameters the document declares on the webhook, generated from
  // their schemas the same way `renderResponse` generates spec-declared
  // response headers. Config headers layer over them, so an explicit value
  // always wins over a generated one.
  const headers: Record<string, string> = {}
  for (const parameter of spec.headers) {
    const value = generateValue(parameter.schema, input.rng, input.generateOptions)
    if (value !== undefined && value !== null) headers[parameter.name.toLowerCase()] = String(value)
  }
  for (const [name, value] of Object.entries(input.config.headers)) {
    headers[name.toLowerCase()] = value
  }
  if (body !== '') headers['content-type'] = 'application/json'
  if (input.config.secret !== undefined) {
    const signature = await sign(input.config.secret, body, input.now())
    headers[SIGNATURE_HEADER] = signature.header
  }

  return await deliver({
    webhook: input.name,
    url,
    body,
    headers,
    captureOnly: input.captureOnly,
    retry: input.config.retry,
    seed: input.seed,
    fetch: input.fetch,
    sleep: input.sleep
  })
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/webhooks/emit.test.ts`

Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: compose webhook emission' -m 'Resolves a destination through the four documented tiers, generates the payload from the declared schema, layers overrides over it exactly as a response body override layers, signs when a secret is set, and delivers.' -m 'The callback store key is exported because the pipeline writes what this module reads, and two spellings of one convention drift silently. The delivery log is an in-memory bounded ring buffer, because Store has no enumeration primitive.'
```

---

## Task 6: Capture callback URLs from live requests

Destination tier 2. When a request reaches an operation declaring `callbacks`,
the expression resolves against that request and the URL is stored.

Capture happens **at the single exit, and only for a response under 400.** A
rejected request has not subscribed to anything, and doing it at the exit means
`$response.*` and `$statusCode` expressions can resolve too.

**Files:**
- Modify: `src/server/handler.ts`, `src/runtime/types.ts`
- Test: `test/server/webhooks.test.ts` (create)

**Interfaces:**
- Consumes: `isSupported`, `resolveExpression`, `ExprInput` (Task 2); `callbackKey` (Task 5).
- Produces:
  - `interface EmitCtx extends Ctx { result: { status: number; headers: Record<string, string>; body: unknown } }` in `src/runtime/types.ts`
  - `HandlerOptions.onWarn?: (message: string) => void`
  - In `handler.ts`: a construction-time compile of every operation's callbacks, and capture at the exit.

- [ ] **Step 1: Write the failing test**

Create `test/server/webhooks.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { callbackKey } from '../../src/webhooks/emit.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/subscriptions': {
      post: {
        operationId: 'subscribe',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    },
    '/guarded': {
      post: {
        operationId: 'guarded',
        security: [{ bearer: [] }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: { '201': { description: 'created' } },
        callbacks: {
          onOrderShipped: {
            '{$request.body#/callbackUrl}': {
              post: { responses: { '200': { description: 'ok' } } }
            }
          }
        }
      }
    }
  },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }
}

const api = loadApi(doc)

const subscribe = (path = '/subscriptions', headers: Record<string, string> = {}) =>
  new Request(`http://mock${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ callbackUrl: 'http://hooks.test/mine' })
  })

test('a subscribing request captures its callback url', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await handler.fetch(subscribe())
  assert.equal(
    await handler.store.get(callbackKey('onOrderShipped')),
    'http://hooks.test/mine'
  )
})

test('a rejected request captures nothing', async () => {
  // A 401 has not subscribed to anything. Capturing from it would let an
  // unauthenticated caller redirect another tenant's webhooks.
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(subscribe('/guarded'))
  assert.equal(response.status, 401)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an operation declaring no callbacks captures nothing', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await handler.fetch(new Request('http://mock/subscriptions', { method: 'GET' }))
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unresolvable expression captures nothing and does not throw', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const response = await handler.fetch(
    new Request('http://mock/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ somethingElse: true })
    })
  )
  assert.equal(response.status, 201)
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})

test('an unsupported expression warns once at construction and is skipped', async () => {
  const warnings: string[] = []
  const unsupported = loadApi({
    ...doc,
    paths: {
      '/subscriptions': {
        post: {
          operationId: 'subscribe',
          responses: { '201': { description: 'created' } },
          callbacks: {
            onOrderShipped: {
              '{$request.cookie.cb}': {
                post: { responses: { '200': { description: 'ok' } } }
              }
            }
          }
        }
      }
    }
  })

  const handler = createHandler(unsupported, {
    seed: 'hooks',
    onWarn: (message) => warnings.push(message)
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /\$request\.cookie\.cb/)
  assert.match(warnings[0]!, /onOrderShipped/)

  await handler.fetch(new Request('http://mock/subscriptions', { method: 'POST' }))
  assert.equal(await handler.store.get(callbackKey('onOrderShipped')), undefined)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server/webhooks.test.ts`

Expected: FAIL — nothing is captured; `onWarn` is not a known option.

- [ ] **Step 3: Add `EmitCtx`**

In `src/runtime/types.ts`, after `Ctx`:

```ts
/**
 * What an emit override function receives: the request `Ctx` plus the finished
 * response.
 *
 * `result` is a separate type rather than an optional field on `Ctx` because
 * `Ctx` is built before a response exists — `result` would then be `undefined`
 * throughout every ordinary resolver, header override, and response callback,
 * and a field that is only sometimes real is a field that gets read when it is
 * not. See the webhooks design §2.4.
 */
export interface EmitCtx extends Ctx {
  result: {
    status: number
    headers: Record<string, string>
    body: unknown
  }
}
```

- [ ] **Step 4: Compile callbacks and capture at the exit**

In `src/server/handler.ts`, add to `HandlerOptions`:

```ts
  /**
   * Where startup warnings go — an unsupported runtime expression, for one.
   * Injectable so a test can assert on it without capturing the console, and
   * so an embedding application can route it.
   */
  onWarn?: (message: string) => void
```

In `createHandler`, near the other construction-time compilation:

```ts
  const warn = options.onWarn ?? ((message: string) => console.warn(message))

  // Compiled once. An expression outside the documented subset warns here
  // rather than silently never firing — the same reasoning as `compileTarget`
  // throwing on a target that matches nothing.
  const callbacks = api.operations.map((operation) => ({
    operation,
    specs: operation.callbacks.filter((callback) => {
      if (isSupported(callback.expression)) return true
      warn(
        `mockingham: callback "${callback.name}" on ` +
          `${operation.method.toUpperCase()} ${operation.path} uses the runtime ` +
          `expression ${callback.expression}, which is outside the supported ` +
          'subset. It will not capture a destination.'
      )
      return false
    })
  }))
```

At the single exit in `handle()`, after the log block and before `return response`:

```ts
    // Destination tier 2. Only for a response the operation actually accepted:
    // a 401 has not subscribed to anything, and capturing from one would let an
    // unauthenticated caller redirect another tenant's webhooks. Doing it here
    // rather than mid-pipeline also means `$response.*` and `$statusCode`
    // resolve, because the result exists.
    if (trace.operation !== undefined && response.status < 400) {
      try {
        const entry = callbacks.find((candidate) => candidate.operation === trace.operation)
        if (entry !== undefined && entry.specs.length > 0) {
          const exprInput = {
            request,
            url: new URL(request.url),
            method: request.method,
            params: trace.params,
            body: trace.ctx?.body,
            result: {
              status: response.status,
              headers: headersOf(response),
              body: parseBodyText(captured, response)
            }
          }
          for (const callback of entry.specs) {
            const resolved = resolveExpression(callback.expression, exprInput)
            if (resolved.ok) await store.set(callbackKey(callback.name), resolved.value)
          }
        }
      } catch (error) {
        reportError(options.onError, error, trace.ctx)
      }
    }
```

`captured` is only read when something needs the body, so capture must join that
condition. Change the `needsBody` line to include callbacks:

```ts
    const hasCallbacks =
      trace.operation !== undefined &&
      callbacks.some(
        (candidate) => candidate.operation === trace.operation && candidate.specs.length > 0
      )
    const needsBody = claimed !== undefined || options.onLog !== undefined || hasCallbacks
```

Add the small parser used above, next to `captureBody`:

```ts
  /**
   * The response body as a value, for `$response.body#/…` and for `EmitCtx`.
   * A non-JSON body stays a string rather than becoming `undefined`, so an
   * expression pointing at a text body still resolves.
   */
  function parseBodyText(text: string | null, response: Response): unknown {
    if (text === null || text === '') return undefined
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('json')) return text
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
```

Import `isSupported`, `resolveExpression` from `../webhooks/expr.ts` and
`callbackKey` from `../webhooks/emit.ts`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/server/webhooks.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Confirm the rejected-request test is load-bearing**

Remove `&& response.status < 400` from the capture condition, run the file, and
confirm `a rejected request captures nothing` fails. Restore it. **Report the
exact failure message.**

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 8: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: capture callback urls from subscribing requests' -m 'A request reaching an operation that declares callbacks has its runtime expression resolved against the live request, and the destination stored. Capture happens at the single exit and only for a response under 400: a rejected request has not subscribed to anything, and an unauthenticated caller must not be able to redirect a webhook.' -m 'An expression outside the supported subset warns once at construction through the new onWarn option and is skipped, rather than silently never firing.'
```

---

## Task 7: The imperative surface

`mock.emit()`, `mock.deliveries()`, `mock.clearDeliveries()`.

**Files:**
- Modify: `src/server/handler.ts`, `src/index.ts`
- Test: `test/server/webhooks.test.ts` (extend)

**Interfaces:**
- Produces:
  - `HandlerOptions.webhooks?: Record<string, WebhookConfig>`, `.captureOnly?: boolean`, `.fetch?: typeof fetch`
  - `Handler.emit(name: string, opts?: EmitOptions): Promise<Delivery>`, `.deliveries(): Delivery[]`, `.clearDeliveries(): void`
  - `interface EmitOptions { to?: string; body?: OverrideNode }`
  - The same four on `Mock`.

- [ ] **Step 1: Write the failing test**

Append to `test/server/webhooks.test.ts`:

```ts
test('emit generates a conforming payload and records the delivery', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'captured')
  assert.equal(typeof (JSON.parse(delivery.body) as { orderId: unknown }).orderId, 'string')
  assert.deepEqual(handler.deliveries().map((d) => d.webhook), ['onOrderShipped'])
})

test('emit honors an explicit destination and a body override', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })

  const delivery = await handler.emit('onOrderShipped', {
    to: 'http://explicit.test/x',
    body: { orderId: 'o_9' }
  })

  assert.equal(delivery.url, 'http://explicit.test/x')
  assert.equal((JSON.parse(delivery.body) as { orderId: string }).orderId, 'o_9')
})

test('emit uses a url captured from an earlier subscription', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.fetch(subscribe())

  const delivery = await handler.emit('onOrderShipped')

  assert.equal(delivery.url, 'http://hooks.test/mine')
})

test('emit resolves rather than rejecting when nothing addresses it', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  const delivery = await handler.emit('onOrderShipped')
  assert.equal(delivery.outcome, 'unresolved')
})

test('emit throws on an undeclared webhook name', async () => {
  const handler = createHandler(api, { seed: 'hooks' })
  await assert.rejects(handler.emit('nope'), /nope/)
})

test('clearDeliveries empties the log', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  handler.clearDeliveries()
  assert.deepEqual(handler.deliveries(), [])
})

test('reset clears the delivery log too', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.emit('onOrderShipped')
  await handler.reset()
  assert.deepEqual(handler.deliveries(), [])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server/webhooks.test.ts`

Expected: FAIL — `handler.emit is not a function`.

- [ ] **Step 3: Wire the handler**

In `src/server/handler.ts`, add to `HandlerOptions`:

```ts
  webhooks?: Record<string, WebhookConfig>
  /** Capture every delivery without sending it. See the webhooks design §2.6. */
  captureOnly?: boolean
  /** Injectable so the suite never reaches the network. */
  fetch?: typeof fetch
```

In `createHandler`:

```ts
  const webhookConfigs = new Map<string, ResolvedWebhook>()
  for (const [name, config] of Object.entries(options.webhooks ?? {})) {
    webhookConfigs.set(name, resolveWebhook(config))
  }
  const deliveryLog = createDeliveryLog()
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  /**
   * One emission, from either trigger. Records into the delivery log whatever
   * comes back — including `unresolved` — because §13 says an emit never
   * hard-fails and the log is where an operator sees that it did not.
   */
  async function runEmit(
    name: string,
    opts: { to?: string; body?: OverrideNode; ctx?: unknown } = {}
  ): Promise<Delivery> {
    const delivery = await emitWebhook({
      name,
      api,
      config: webhookConfigs.get(name) ?? resolveWebhook(),
      store,
      captureOnly: options.captureOnly === true,
      seed,
      rng: createRng(`${seed}|webhook|${name}|${counters.next(`webhook|${name}`)}`),
      generateOptions: {
        maxDepth: options.maxDepth,
        preferExamples: options.preferExamples,
        resolvers,
        schemaNames: api.schemaNames
      },
      fetch: doFetch,
      sleep,
      now,
      to: opts.to,
      bodyOverride: opts.body,
      ctx: opts.ctx
    })
    deliveryLog.record(delivery)
    return delivery
  }
```

The payload rng is keyed by webhook name and a per-name counter, so two emissions
of the same webhook produce different payloads while a replayed run produces the
same pair — the same reasoning as the request ordinal.

Add to the returned object:

```ts
    emit: (name, opts = {}) => runEmit(name, opts),
    deliveries: () => deliveryLog.all(),
    clearDeliveries: () => deliveryLog.clear(),
```

and add `deliveryLog.clear()` inside `reset()`.

Extend the `Handler` interface with the three members and
`interface EmitOptions { to?: string; body?: OverrideNode }`.

- [ ] **Step 4: Expose them on `Mock`**

In `src/index.ts`, add to `Mock` and the returned object:

```ts
  emit(name: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(): Delivery[]
  clearDeliveries(): void
```

```ts
    emit: (name, opts) => handler.emit(name, opts),
    deliveries: () => handler.deliveries(),
    clearDeliveries: () => handler.clearDeliveries(),
```

Re-export the types: `export type { Delivery } from './webhooks/deliver.ts'` and
`export type { WebhookConfig } from './webhooks/emit.ts'`.

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/server/webhooks.test.ts`

Expected: PASS, 12 tests.

- [ ] **Step 6: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: add the imperative webhook surface' -m 'mock.emit(), mock.deliveries(), and mock.clearDeliveries(). An emit resolves with its Delivery in every case including unresolved, so never hard-failing is a property of the return type rather than only of the implementation.' -m 'The payload rng is keyed by webhook name and a per-name counter, so two emissions of one webhook differ while a replayed run reproduces both.'
```

---

## Task 8: Operation-linked emits and the emission lifecycle

The second trigger, plus `settled()`, `close()`, and `reset()`.

**Files:**
- Modify: `src/runtime/config.ts`, `src/server/handler.ts`, `src/index.ts`
- Test: `test/server/webhooks.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface EmitConfig { webhook: string; afterMs?: number | ((ctx: EmitCtx) => number); body?: OverrideNode }`
  - `OperationConfig.emits?: EmitConfig[]`, `ResolvedConfig.emits: EmitConfig[]`
  - `Handler.settled(): Promise<void>`, `Handler.close(): Promise<void>`
  - `Mock.settled(): Promise<void>`; `Mock.close()` drains emissions before closing the server.

- [ ] **Step 1: Write the failing test**

Append to `test/server/webhooks.test.ts`:

```ts
test('an operation-linked emit fires after the response and is drained by settled', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  const response = await handler.fetch(subscribe())

  // The response does not wait for the emission — §13.
  assert.equal(response.status, 201)
  assert.deepEqual(handler.deliveries(), [])

  await handler.settled()
  assert.equal(handler.deliveries().length, 1)
})

test('afterMs is awaited through the injected sleep, not the real clock', async () => {
  const slept: number[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: async (ms) => { slept.push(ms) },
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 200 }] } }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  assert.deepEqual(slept, [200])
})

test('an emit body override sees the finished response through ctx.result', async () => {
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: {
      subscribe: {
        emits: [{
          webhook: 'onOrderShipped',
          body: { orderId: (ctx: EmitCtx) => `from-${ctx.result.status}` }
        }]
      }
    }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  const body = JSON.parse(handler.deliveries()[0]!.body) as { orderId: string }
  assert.equal(body.orderId, 'from-201')
})

test('afterMs may be a function of the emit context', async () => {
  const slept: number[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: async (ms) => { slept.push(ms) },
    operations: {
      subscribe: {
        emits: [{ webhook: 'onOrderShipped', afterMs: (ctx: EmitCtx) => ctx.result.status }]
      }
    }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  assert.deepEqual(slept, [201])
})

test('a throwing emit override never reaches the response', async () => {
  const seen: unknown[] = []
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    onError: (error) => seen.push(error),
    operations: {
      subscribe: {
        emits: [{ webhook: 'onOrderShipped', body: { orderId: () => { throw new Error('boom') } } }]
      }
    }
  })

  const response = await handler.fetch(subscribe())
  await handler.settled()

  assert.equal(response.status, 201)
  assert.equal((seen[0] as Error).message, 'boom')
})

test('reset drops a pending emission', async () => {
  let release: (() => void) | undefined
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: () => new Promise<void>((resolve) => { release = resolve }),
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 50 }] } }
  })

  await handler.fetch(subscribe())
  await handler.reset()
  release?.()
  await handler.settled()

  assert.deepEqual(handler.deliveries(), [])
})

test('close drops a pending emission and settles', async () => {
  let release: (() => void) | undefined
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    sleep: () => new Promise<void>((resolve) => { release = resolve }),
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped', afterMs: 50 }] } }
  })

  await handler.fetch(subscribe())
  const closing = handler.close()
  release?.()
  await closing

  assert.deepEqual(handler.deliveries(), [])
})

test('an operation with no emits config emits nothing', async () => {
  const handler = createHandler(api, { seed: 'hooks', captureOnly: true })
  await handler.fetch(subscribe())
  await handler.settled()
  assert.deepEqual(handler.deliveries(), [])
})
```

Add `import type { EmitCtx } from '../../src/runtime/types.ts'` to the file.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/server/webhooks.test.ts`

Expected: FAIL — `handler.settled is not a function`, and `emits` is not a known
operation config key.

- [ ] **Step 3: Add the config**

In `src/runtime/config.ts`:

```ts
export interface EmitConfig {
  webhook: string
  /** Delay before delivery, awaited through the injected `sleep`. */
  afterMs?: number | ((ctx: EmitCtx) => number)
  /** Layered over the generated payload, exactly as a response body override is. */
  body?: OverrideNode
}
```

Add `emits?: EmitConfig[]` to `OperationConfig`, `emits: EmitConfig[]` to
`ResolvedConfig`, and in `resolveConfigs` collect them across every matching
config in declaration order:

```ts
  const emits: EmitConfig[] = []
  for (const entry of matching) {
    if (entry.emits !== undefined) emits.push(...entry.emits)
  }
```

Return `emits` alongside the rest. Import `EmitCtx` as a type.

- [ ] **Step 4: Wire the lifecycle into the handler**

In `createHandler`:

```ts
  // Pending emissions. `settled()` drains them, `close()` stops accepting new
  // ones, and `reset()` invalidates the ones already waiting. A generation
  // counter rather than real timer handles: `sleep` is injected, so there is no
  // timer object to cancel, and checking a generation after the wait is both
  // simpler and testable.
  const pending = new Set<Promise<void>>()
  let generation = 0
  let closed = false

  function track(promise: Promise<void>): void {
    pending.add(promise)
    void promise.finally(() => pending.delete(promise))
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending])
  }
```

`trace` gains `emits?: EmitConfig[]`, set in `produce` from
`config.emits` right after `resolveConfigs`.

At the single exit, after the callback-capture block:

```ts
    // Trigger two. Registered inside the exit's guard, so a throw in an emit
    // override, in signing, or in delivery reaches `onError` and can never
    // reach the response the caller already holds.
    if (trace.emits !== undefined && trace.emits.length > 0 && !closed) {
      const ctx = trace.ctx
      if (ctx !== undefined) {
        // `createContext` returns a plain object whose methods are own
        // properties, so a spread carries `respond`, `deny`, and `seq` across
        // intact. `result` is added rather than assigned into `ctx`, so the
        // request context every other consumer holds is left untouched.
        const emitCtx: EmitCtx = {
          ...ctx,
          result: {
            status: response.status,
            headers: headersOf(response),
            body: parseBodyText(captured, response)
          }
        }
        const at = generation
        for (const emit of trace.emits) {
          track((async () => {
            try {
              const delay = typeof emit.afterMs === 'function' ? emit.afterMs(emitCtx) : emit.afterMs
              if (delay !== undefined && delay > 0) await sleep(delay)
              // A reset or a close while this was waiting invalidates it.
              if (closed || at !== generation) return
              await runEmit(emit.webhook, { body: emit.body, ctx: emitCtx })
            } catch (error) {
              reportError(options.onError, markCallback(error), emitCtx)
            }
          })())
        }
      }
    }
```

`runEmit` already records into the delivery log.

Add to the returned handler:

```ts
    settled,
    async close() {
      closed = true
      await settled()
    },
```

and in `reset()`, before `await store.clear()`:

```ts
      generation += 1
      deliveryLog.clear()
```

- [ ] **Step 5: Drain on `Mock.close()`**

In `src/index.ts`:

```ts
    async close() {
      // Emissions in flight are dropped rather than delivered after the server
      // is gone; §13 says close() cancels them.
      await handler.close()
      await server.close()
    },
    settled: () => handler.settled(),
```

Add `settled(): Promise<void>` to the `Mock` interface.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test test/server/webhooks.test.ts`

Expected: PASS, 20 tests.

- [ ] **Step 7: Confirm the response really does not wait**

Change the exit to `await` each emission instead of tracking it, run the file,
and confirm `an operation-linked emit fires after the response and is drained by
settled` fails on its `assert.deepEqual(handler.deliveries(), [])` — the
emission would already have completed. Restore. **Report the exact failure
message.** This is the observation that proves §13's "never blocks or delays the
triggering response".

- [ ] **Step 8: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 9: Commit**

```sh
git add -A
```

```sh
git commit -m 'feat: fire webhooks from operations and manage their lifecycle' -m 'An operation config may declare emits; they fire at the single exit after the response is final, never delaying it. settled() drains them, close() stops accepting new ones, and reset() invalidates those already waiting through a generation counter.' -m 'Emit overrides receive an EmitCtx carrying the finished response, reusing the body capture the exit already performs. A throw anywhere in emission reaches onError and never the response.'
```

---

## Task 9: End-to-end and one real delivery

Two integration surfaces: `captureOnly` with no receiver, and exactly one real
loopback delivery covering signing and retry over a socket.

**Files:**
- Create: `test/server/webhooks-loopback.test.ts`
- Test: `test/server/webhooks.test.ts` (extend with the schema-conformance test)

**Interfaces:**
- Consumes: everything above; `compileSchema` (`src/schema/compile.ts`); `createMock` (`src/index.ts`).

- [ ] **Step 1: Write the conformance test**

Append to `test/server/webhooks.test.ts`:

```ts
test('the delivered payload validates against the declared webhook schema', async () => {
  // `deliveries().length === 1` is true whether or not the payload conformed to
  // anything, and conforming is the entire point of generating it from the
  // document. Validate it with the same compiler the request path uses.
  const handler = createHandler(api, {
    seed: 'hooks',
    captureOnly: true,
    operations: { subscribe: { emits: [{ webhook: 'onOrderShipped' }] } }
  })

  await handler.fetch(subscribe())
  await handler.settled()

  const schema = api.webhooks['onOrderShipped']!.body!['application/json']!.schema
  const parsed = compileSchema(schema).safeParse(JSON.parse(handler.deliveries()[0]!.body))
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues))
})
```

Add `import { compileSchema } from '../../src/schema/compile.ts'`.

- [ ] **Step 2: Write the loopback test**

Create `test/server/webhooks-loopback.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMock } from '../../src/index.ts'

const doc = {
  openapi: '3.1.0',
  webhooks: {
    onOrderShipped: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['orderId'],
                properties: { orderId: { type: 'string' } }
              }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {}
}

interface Received {
  body: string
  signature?: string
}

/** A throwaway receiver. `failFirst` makes the first attempt a 500. */
function receiver(failFirst: boolean): Promise<{
  url: string
  received: Received[]
  close(): Promise<void>
  server: Server
}> {
  const received: Received[] = []
  let calls = 0
  return new Promise((resolve) => {
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString(),
          signature: incoming.headers['x-mockingham-signature'] as string | undefined
        })
        calls += 1
        outgoing.writeHead(failFirst && calls === 1 ? 500 : 200)
        outgoing.end()
      })
    })
    server.listen(0, () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}/hook`,
        received,
        server,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

async function verify(secret: string, header: string, body: string): Promise<boolean> {
  const [rawTs, rawSig] = header.split(',')
  const timestamp = rawTs!.slice('t='.length)
  const expected = rawSig!.slice('v1='.length)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const mac = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)
  )
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex === expected
}

test('a real delivery arrives signed and verifiable', async () => {
  const hook = await receiver(false)
  const mock = createMock(doc, {
    seed: 'loopback',
    webhooks: { onOrderShipped: { url: hook.url, secret: 'topsecret' } }
  })

  const delivery = await mock.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.status, 200)
  assert.equal(hook.received.length, 1)
  assert.equal(hook.received[0]!.body, delivery.body)

  // The signature the receiver got verifies against the body it got — the
  // security-critical path a consumer will implement.
  const header = hook.received[0]!.signature
  assert.ok(header, 'no signature header arrived')
  assert.equal(await verify('topsecret', header, hook.received[0]!.body), true)
  assert.equal(await verify('wrong', header, hook.received[0]!.body), false)

  await mock.close()
  await hook.close()
})

test('a real delivery retries a 500 and succeeds on the second attempt', async () => {
  const hook = await receiver(true)
  const slept: number[] = []
  const mock = createMock(doc, {
    seed: 'loopback',
    sleep: async (ms) => { slept.push(ms) },
    webhooks: { onOrderShipped: { url: hook.url, retry: { attempts: 3 } } }
  })

  const delivery = await mock.emit('onOrderShipped')

  assert.equal(delivery.outcome, 'delivered')
  assert.equal(delivery.attempts, 2)
  assert.equal(hook.received.length, 2)
  assert.equal(slept.length, 1)

  await mock.close()
  await hook.close()
})
```

- [ ] **Step 3: Run both files**

Run: `node --test test/server/webhooks.test.ts`

Expected: PASS, 21 tests.

Run: `node --test test/server/webhooks-loopback.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 4: Confirm the conformance test is load-bearing**

In `emit.ts`, replace the generated payload with `{}` (`const generated = {}`),
run `node --test test/server/webhooks.test.ts`, and confirm the conformance test
fails on the missing required property rather than on the delivery count.
Restore. **Report the exact failure message.**

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit**

```sh
git add -A
```

```sh
git commit -m 'test: cover webhooks end to end and over a real socket' -m 'captureOnly proves the whole path with no receiver, including that the delivered payload validates against the declared schema with the same compiler the request path uses. One loopback delivery to a throwaway node:http receiver covers signing verification and a retried 500.' -m 'No outbound network: the loopback binds an ephemeral port on 127.0.0.1 and closes with the test.'
```

---

## Task 10: Record the amendments and limitations

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-mockingham-webhooks-design.md`, `docs/superpowers/deferred-items.md`, `CLAUDE.md`

- [ ] **Step 1: Mark the design approved and reconcile it with the code**

Change the status line to
`**Status:** approved; implemented by plan 6 (2026-08-12-mockingham-webhooks.md).`

Then verify each of these against the source rather than against this plan, and
correct the document where they differ: the retry defaults in `resolveRetry`, the
`MAX_DELIVERIES` constant, the `SIGNATURE_HEADER` value, the exact `Delivery`
field names and outcome values, and the `callbackKey` spelling.

- [ ] **Step 2: Record what the plan added beyond the design**

Add to §7 known limitations:

```markdown
6. **`onWarn` is a new option.** An unsupported runtime expression has to be
   reported at construction, and neither `onError` (internal faults) nor a bare
   `console.warn` (untestable without monkey-patching, and impolite in a
   library) fit. It defaults to `console.warn`.
7. **A callback URL is captured only from a response under 400.** A rejected
   request has not subscribed to anything, and capturing from one would let an
   unauthenticated caller redirect another tenant's webhooks.
8. **A pending emission is dropped by `reset()` and by `close()`**, not
   delivered. §13 requires both to cancel; a generation counter invalidates
   emissions already waiting on their `afterMs`.
```

- [ ] **Step 3: Update `deferred-items.md`**

Update the status line to record plan 6. Add any finding this plan's reviews
deferred. If none were, say so explicitly rather than leaving the section
looking untouched.

- [ ] **Step 4: Add the webhook rule to `CLAUDE.md`**

Add this as a sixth entry under "Non-negotiable invariants", keeping the file's
existing numbering and voice:

```markdown
6. **Emission never affects the response.** Webhooks fire at the single exit,
   after the response is final. A throw in an emit override, in signing, or in
   delivery reaches `onError` — never the caller. An emit that resolves no
   destination is captured as `unresolved`, not an error.
```

- [ ] **Step 5: Verify and commit**

Run: `npm test`

Expected: PASS.

```sh
git add -A
```

```sh
git commit -m 'docs: record the plan 6 webhook rulings' -m 'Marks the phase 8 design approved and reconciles it with the shipped code, adds the three decisions the plan made beyond it, and records the state in deferred-items.'
```

---

## Definition of done

- [ ] `npm test` is green, up roughly 60 tests from 509.
- [ ] `npx tsc --noEmit` reports nothing.
- [ ] `node:` still appears in exactly two files: `server/node.ts` and `server/cli.ts`.
- [ ] The signing test was observed failing against the known-answer vector with
      the signed string changed, and the message reported.
- [ ] The retry test was observed failing with `shouldRetry` forced true, and
      again with `backoffFor` made constant, and both messages reported.
- [ ] The conformance test was observed failing with the generated payload
      replaced by `{}`, and the message reported.
- [ ] The response-does-not-wait test was observed failing when emissions are
      awaited at the exit, and the message reported.
- [ ] A webhook delivered over a real socket verified its own signature, and a
      retried 500 succeeded on the second attempt.
