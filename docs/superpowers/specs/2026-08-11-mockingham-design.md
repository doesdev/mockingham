# mockingham — Design

**Date:** 2026-08-11
**Status:** Approved for planning

An HTTP mock server that takes an OpenAPI document, adopts its shape, and serves
type-matched randomized responses. Every generated value can be overridden by a
static value, a sync callback, or an async callback, at any depth. The same
layering governs headers. Auth, failure simulation, idempotency, and request
logging are first-class. LLM-generated response content is a first-class option
via a fixture store.

## Goals

- Point it at an OpenAPI 3.0/3.1 document and get a working mock with no further config.
- Make any value overridable without leaving the type system.
- Keep dependencies near zero. `zod` is the only hard runtime dependency.
- Stay testable: the core is a pure function, not a server.

## Non-goals (v1)

YAML parsing, Swagger 2.0, external/remote `$ref` resolution, stateful CRUD
persistence, an HTTP admin control plane, SSE/streaming responses, multipart body
generation, HTTPS termination. Webhooks are in scope (§13) but recurring emitters
and chained deliveries are not.

Each of these is deliberately excluded, not overlooked. The architecture leaves
room for stateful CRUD as a later addition.

## Primary consumer

The first real user of this is an **agent building a client against the mocked
API**. That shapes three decisions that would otherwise be marginal: the MCP
server (§15) is in scope for v1 rather than deferred, webhooks (§13) ship with a
capture mode and an `emit_webhook` tool so an agent can exercise its own receiver,
and the control plane is designed to be driven by something other than a human
from the start.

---

## 1. Architecture

Everything hangs off one pure function:

```ts
const mock = createMock(doc, options)
await mock.fetch(new Request('http://x/users/42'))  // => Promise<Response>
await mock.listen(3000)                              // node:http adapter
```

`fetch` touches no Node APIs, so in-process tests need no sockets and the core
runs unmodified on Bun, Deno, and workers. `listen` is a thin `node:http`
adapter. The CLI wraps `listen`.

### Module layout

```
src/
  spec/
    load.ts        OpenAPI 3.0/3.1 -> internal Api model
    refs.ts        internal $ref resolution, cycle detection
    routes.ts      path template -> matcher, precedence rules
  schema/
    walk.ts        single shared schema traversal
    compile.ts     OpenAPI schema -> zod, memoized
  generate/
    rng.ts         seeded PRNG + FNV-1a key hashing
    values.ts      type/format value producers
    constraints.ts min/max/length/items/multipleOf/enum handling
  resolve/
    layer.ts       override layering, async-aware
  runtime/
    context.ts     ctx construction
    auth.ts        spec-driven auth + verify hooks
    validate.ts    request validation via compiled zod
    failure.ts     latency, rates, circuits, decide()
    idempotency.ts key capture, replay, conflict
    headers.ts     response header generation + layering
    logging.ts     log record assembly and emission
    store.ts       Store interface + MemoryStore
    errors.ts      on-contract error body construction
  webhooks/
    emit.ts        trigger handling, payload assembly
    deliver.ts     outbound fetch, retry, capture
    sign.ts        HMAC signing
    expr.ts        OpenAPI runtime expression resolution
  fixtures/
    store.ts       disk-backed fixture store
    source.ts      ContentSource interface
    anthropic.ts   built-in source (lazy import)
    bake.ts        prewarm walker
  mcp/
    server.ts      tool registration + dispatch
    tools.ts       tool definitions and handlers
  server/
    handler.ts     (Request) => Promise<Response>
    node.ts        node:http adapter
    cli.ts
  index.ts         createMock, types, public exports
```

Each module has one job and is unit-testable in isolation. `schema/walk.ts` is
shared by generation and zod compilation so a schema is interpreted exactly once,
one way — divergence between "what we generate" and "what we validate" would be
the worst possible bug class in this project.

### Instance surface

```ts
interface Mock {
  fetch(req: Request): Promise<Response>
  listen(port?: number): Promise<{ url: string; port: number }>
  close(): Promise<void>

  // control plane
  // Async, against this section's own `void` — the runtime-override cycle's
  // amendment 2.1 follows the code (the Store is async), the same drift §1
  // already had for failNext/outage below.
  override(target: string, value: RuntimeOverride): Promise<void>
  failNext(target: string, opts: FailNextOptions): void
  outage(target: string, opts: OutageOptions): void
  setSeed(seed: string): void
  reset(): Promise<void>   // chaos state, idempotency keys, counters,
                           // runtime overrides, pending emits, deliveries

  emit(webhook: string, opts?: EmitOptions): Promise<Delivery>
  deliveries(filter?: DeliveryFilter): Delivery[]
  clearDeliveries(): void

  bake(opts?: BakeOptions): Promise<BakeReport>
  mcp(opts?: McpOptions): McpServer
  store: Store
}
```

The control plane is a clean programmatic API rather than HTTP endpoints, and
both the MCP server (§15) and any future admin HTTP surface are thin adapters
over it — the same relationship `node.ts` has to `fetch`. Every control-plane
method is therefore designed to be callable by a machine: targets are strings,
arguments are JSON-serializable, and results are structured.

---

## 2. Request pipeline

Ordered stages. Any stage may short-circuit with a `Response`.

| # | Stage | Short-circuits with |
|---|---|---|
| 1 | Route match | 404, or 405 + `Allow` |
| 2 | Body parse / content negotiation | 415, 400 |
| 3 | Auth | 401 / 403 |
| 4 | Request validation | 400 |
| 5 | Idempotency lookup | replayed response |
| 6 | Failure policy | 5xx / 429 |
| 7 | Status selection | — |
| 8 | Generate body + headers | — |
| 9 | Apply override layers | — |
| 10 | Full response callback | replaces everything |
| 11 | Store idempotent result, emit log | — |

### Route matching

Paths compile to a sorted matcher table. Static segments beat dynamic ones at
equal depth (`/users/me` wins over `/users/{id}`). Path params are decoded and
coerced per their declared schema before validation. A path that matches but with
no matching method produces 405 with a correct `Allow` header.

### Body parsing

`application/json`, `application/x-www-form-urlencoded`, and `text/*` are parsed.
Anything else is exposed as raw bytes on `ctx.body` and skipped by validation.
Unsupported request content types for an operation produce 415.

### Status selection

Default is the lowest declared 2xx. Overridable per operation statically or by
callback. Clients may request a specific outcome with `Prefer` — `Prefer: status=201`
or `Prefer: example=empty-list` — matching the convention Prism established, so
existing tooling and habits carry over.

---

## 3. Value generation

### Determinism

Seed = `hash(rootSeed, requestKey)` where `requestKey` is `method + templated path
+ resolved path params + configured query/header contributors`. Consequently:

- `GET /users/42` returns the same fake user every time, across process restarts.
- `GET /users/43` returns a different one.
- `new Mock(doc, { seed: 'ci-run-7' })` varies an entire run.
- `random: true` per operation opts out.

PRNG is an owned ~10-line mulberry32; key hashing is FNV-1a. Both are ~20 lines
total and avoid a dependency for something this small.

### Precedence within a single value

```
override > fixture > spec example/examples > default > enum pick > format producer > type default
```

`preferExamples` (default `true`) is what puts spec examples above generation: if
the API author wrote an example, honor it. Set `false` to always generate.

### Formats and constraints

Producers for: `date-time`, `date`, `time`, `duration`, `uuid`, `email`, `uri`,
`hostname`, `ipv4`, `ipv6`, `byte`, `binary`, `password`, plus `int32`/`int64`/
`float`/`double` numerics. Constraints honored: `minLength`, `maxLength`,
`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
`minItems`, `maxItems`, `uniqueItems`, `enum`, `const`, `nullable`,
`oneOf`/`anyOf` (seeded pick, discriminator-aware), `allOf` (merged).

**Defined limitation — `pattern`.** A minimal regex generator covers literals,
character classes, anchors, and bounded quantifiers. Anything outside that subset
falls back to `example`, then `default`, then a deterministic placeholder, and
emits a single startup warning naming the schema path. Generating from arbitrary
regex is out of scope; the escape hatch is an override or a fixture.

Recursive schemas are detected during `$ref` resolution and generated to a
configurable `maxDepth` (default 3), then terminated with `null` if nullable or
an empty object/array otherwise.

---

## 4. Overrides

### Target strings

One syntax addresses operations everywhere it is needed — `operations` keys,
`failure[].match`, and the control-plane methods:

```
'GET /users/{id}'      method + exact path template as written in the document
'GET /orders/*'        '*' matches one segment, '**' matches the rest
'* /users/{id}'        any method
'getUserById'          an operationId
```

Ambiguous targets that match no operation fail loudly at construction time;
control-plane calls with an unmatched target throw.

### Layers

Three layers, most specific first.

```ts
createMock(doc, {
  resolvers: {
    byFormat: { email: () => 'x@y.z' },
    byName: [
      ['*_id', ctx => ctx.seq('id')],   // glob by default
      [/^user[A-Z]/, () => 'u_1']       // RegExp accepted
    ],
    bySchema: { User: { id: ctx => ctx.seq('user') } }
  },
  operations: {
    'GET /users/{id}': {
      200: {
        body: {
          email: 'a@b.c',                     // static
          createdAt: () => new Date(),        // sync fn
          roles: { 0: 'admin', '*': r => r }, // index and wildcard
          profile: { bio: async () => fetchBio() }
        },
        headers: { 'x-rate-limit-remaining': () => 99 }
      }
    }
  }
})
```

Any node may be a value, a function (sync or async), or a deeper object. Array
nodes accept numeric-index keys and `'*'`. Async leaves across the whole tree are
collected and awaited in a single `Promise.all`, so a body with fifty async
overrides costs one tick, not fifty.

Precedence: `operations` > `bySchema` > `byName` > `byFormat` > generated. `byName`
is an ordered list and the first matching entry wins, so specific patterns go
before general ones.

### Full response callback

Replaces everything for an operation, and receives schema-derived helpers:

```ts
'POST /orders': {
  respond: async ctx => {
    if (ctx.body.total > 10_000) return ctx.respond(402)   // on-contract 402
    const body = ctx.generate(201)                          // seeded generation
    body.id = ctx.seq('order')
    return ctx.respond(201, ctx.schema.response(201).parse(body))
  }
}
```

`ctx` exposes: `req`, `params`, `query`, `headers`, `body`, `auth`, `seq(name)`,
`store`, `rng`, `schema.request()`, `schema.response(status)`, `example(status,
name?)`, `generate(status)`, `respond(status, body?, headers?)`, `deny(status,
code?)`, `log` (extra fields merged into the log record).

---

## 5. Headers

Response headers are layered exactly like bodies. Listed in **increasing**
precedence — later layers overwrite earlier ones:

1. Headers declared in the operation's response object, generated from their schemas.
2. Global `headers` defaults from config.
3. `byName` resolvers.
4. Per-operation header overrides.
5. Transport headers computed last and never overridable: `Content-Type` from
   negotiation and `Content-Length`.

When `debugHeaders: true`, `x-mock-seed`, `x-mock-operation`, and
`x-mock-status-source` are added alongside the transport headers.

`Idempotent-Replay: true` is added to replayed responses.

---

## 6. Validation

One memoized OpenAPI-schema → zod compiler serves three jobs: validating incoming
requests, validating user-supplied config, and exposing `ctx.schema.*` to response
callbacks.

`validateRequests` defaults to `true`. Path params, query params, headers, and
body are validated against the operation's declared schemas. Failures produce 400
with a flattened error list:

```json
{ "code": "MOCK_REQUEST_INVALID",
  "errors": [{ "path": "body.age", "message": "Expected number, received string" }] }
```

Compilation is memoized on resolved-schema identity, so a `User` referenced by
twenty operations compiles once.

---

## 7. Errors stay on-contract

When mockingham emits an error itself — 401, 400, 503, 429 — it first looks for
that status in the operation's declared `responses`. If declared, it generates a
body from *that* schema so the client's error-path parsing gets exercised too.
Only if the status is undeclared does it fall back to its own envelope.

`errorBody: 'contract' | 'diagnostic' | (ctx, err) => body`, default `'contract'`.
In `'contract'` mode the diagnostic is still available on the
`x-mock-error` header when `debugHeaders` is on, so a contract-shaped 400 is
still debuggable.

---

## 8. Auth

Spec-driven. `securitySchemes` and per-operation `security` are enforced by
default: a missing or malformed credential produces 401, unmet declared scopes
produce 403, both in the operation's own error shape.

```ts
auth: {
  bearerAuth: {
    verify: async (token, ctx) => {
      if (token === 'expired') return ctx.deny(401, 'token_expired')
      return { sub: 'u_1', scopes: ['orders:read'] }
    }
  },
  apiKey: true   // presence check only, per the spec
}
```

A scheme with no entry gets a presence/shape check derived from the document.
The principal returned by `verify` lands on `ctx.auth` for all later callbacks.
Supported scheme types: `http` (bearer, basic), `apiKey` (header, query, cookie),
`oauth2` and `openIdConnect` (treated as bearer with scope checking).

---

## 9. Failure simulation

Declarative policies for long-lived behavior, an imperative control plane for
tests, and a callback escape hatch.

```ts
failure: [{
  match: 'GET /orders/*',
  latency: { p50: 30, p99: 800 },        // or fixed ms, or (ctx) => ms
  rate: 0.05, respond: 503,
  circuit: { after: 3, openFor: 10_000, then: 429 }
}],
decide: ctx => ctx.headers['x-chaos'] ? { status: 500 } : undefined
```

```ts
mock.failNext('POST /orders', { times: 2, status: 500 })
mock.outage('GET /users', { forMs: 5_000 })
mock.reset()
```

Evaluation order within stage 6: `decide()` → one-shot (`failNext`) → outage →
circuit state → rate → latency. Latency applies even when the request succeeds.
Rate rolls are drawn from the seeded PRNG so a run is reproducible; pass
`chaosSeed` to vary chaos independently of content.

All failure state lives in the `Store`, so it works across a multi-instance mock.

---

## 10. State: one Store kernel

```ts
interface Store {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown, ttlMs?: number): Promise<void>
  delete(key: string): Promise<void>
  incr(key: string, by?: number): Promise<number>
}
```

Default `MemoryStore` is a `Map` with lazy TTL sweep on access plus a bounded
periodic sweep. Idempotency records, chaos state, and `ctx.seq()` counters all sit
on this one interface, so swapping in Redis makes a multi-instance mock work with
no other changes. No entity persistence — a POST does not make the entity
retrievable by a later GET.

---

## 11. Idempotency

```ts
idempotency: {
  header: 'Idempotency-Key',
  methods: ['POST', 'PATCH'],
  ttlMs: 86_400_000,
  scope: ['key', 'route', 'bodyHash'],
  conflictStatus: 409
}
```

Auto-enabled for an operation when the spec declares an `Idempotency-Key` header
parameter. Behavior:

- First request stores `{ status, headers, body, fingerprint }` under the scoped key.
- Replay returns the stored response plus `Idempotent-Replay: true`.
- Same key, different body fingerprint → `409` with `MOCK_IDEMPOTENCY_MISMATCH`.
- Key seen but no stored response yet → `409` with `MOCK_IDEMPOTENCY_IN_FLIGHT`.
  The lookup and the claim are two separate `Store` calls with no atomicity
  across the await, so this is reliably reachable only for a *wedged prior*
  request — one whose process died mid-request, or whose handler threw before
  the boundary catch released the marker. Two genuinely concurrent identical
  requests in the same process can both read no record and both proceed; a
  `Store` with a compare-and-set primitive would close that gap. See the
  phases 7-9 design §6, known limitation 6.

Both 409s are emitted on-contract per §7.

---

## 12. Logging

A single `onLog(record)` callback, invoked fire-and-forget with error isolation —
a throwing logger never affects a response. The record is shaped for direct
mapping onto Datadog/OTel-style sinks, with low-cardinality fields separated from
high-cardinality ones:

```ts
{
  ts, durationMs, requestId,
  method, route,            // route is the TEMPLATED path — low cardinality tag
  path,                     // resolved path — high cardinality, not a tag
  status, bytesIn, bytesOut,
  params, query,
  seed, operationId,
  decisions: { auth?, validation?, failure?, idempotency?, fixture? },
  error?, custom            // ctx.log contributions
}
```

`onError(err, ctx)` is separate and covers internal faults. A Datadog mapping
example lives in the docs, not in code — no dependency.

---

## 13. Webhooks and callbacks

The mock emits outbound requests whose bodies conform to the document's declared
schemas. Both OpenAPI shapes are supported:

- **`webhooks`** (3.1, top-level) — outbound requests the API makes, described as
  path items.
- **`callbacks`** (3.0 and 3.1, per-operation) — out-of-band requests triggered by
  a specific operation, whose destination is given by a runtime expression.

Emission reuses the existing machinery wholesale: payloads come from §3
generation, are shaped by the §4 override layers, carry §5-layered headers, can be
baked by the §14 fixture store, and record their outcome through §12 logging.
The only genuinely new code is delivery, expression resolution, and signing.

### Triggers

Two, and deliberately no more.

**Imperative** — the control plane and MCP:

```ts
await mock.emit('onOrderShipped', { to: url, body: { id: 'o_1' } })
```

**Operation-linked** — declared in config, fired after the response is returned:

```ts
operations: {
  'POST /orders': {
    emits: [{
      webhook: 'onOrderShipped',
      afterMs: 200,                                   // or (ctx) => ms
      body: { orderId: ctx => ctx.result.body.id }    // full §4 layering
    }]
  }
}
```

`afterMs` is a single awaited timer bound to the request's lifetime, not a
scheduler entry — it is canceled by `close()` and cleared by `reset()`. There is
no background job, no persistence, and no lifecycle to reason about. Emission
never blocks or delays the triggering response; a delivery failure is logged and
never affects it.

Excluded on purpose: recurring emitters, chained webhooks where one delivery
triggers another, and retry durable across restarts. Each would require a real
scheduler, and that is the one part of this feature that would touch modules
other than its own.

### Destinations

Resolved in precedence order:

1. Explicit `to:` on the `emit()` call.
2. A URL captured at runtime from the callback's OpenAPI runtime expression —
   `{$request.body#/callbackUrl}`, `{$request.query.url}`, `{$request.header.x-cb}`
   — recorded in the Store when a client subscribed via a real request. This is
   what makes the common "client POSTs its own callback URL" flow work.
3. A static per-webhook `url` from config.
4. Nothing resolves → the delivery is captured but not sent, and logged as
   `unresolved`. An emit never hard-fails.

Supported runtime expression subset: `$url`, `$method`, `$statusCode`,
`$request.{header|query|path}.name`, `$request.body#/json-pointer`, and the
`$response.*` equivalents. Anything outside the subset warns at startup and falls
through to the next destination tier.

### Delivery, signing, capture

```ts
webhooks: {
  onOrderShipped: {
    url: 'http://localhost:5173/hooks/shipped',
    secret: process.env.HOOK_SECRET,
    retry: { attempts: 3, backoff: 'exponential', maxDelayMs: 10_000 },
    headers: { 'x-source': 'mockingham' }
  }
},
captureOnly: false
```

Delivery is `fetch` with retry and jittered exponential backoff; attempt state
lives in the Store. Non-2xx responses retry, 4xx other than 408/429 do not.

**Signing** is on whenever `secret` is set: HMAC-SHA256 over
`timestamp + '.' + rawBody`, sent as `x-mockingham-signature: t=<ts>,v1=<hex>`
using `node:crypto`. This exists so the client's signature-verification path —
the security-critical one — is exercised before production rather than after.

**Capture mode** records every delivery instead of, or alongside, sending it:

```ts
mock.deliveries()   // [{ webhook, url, body, headers, status, attempts, error? }]
mock.clearDeliveries()
```

`captureOnly: true` makes webhooks fully testable in-process with no receiver,
the same way `fetch()` made responses testable without a port.

---

## 14. Fixtures and LLM content

### The idea

The request-identity hash already computed for the PRNG seed doubles as a
content-addressed cache key. LLM content is therefore not a new subsystem: it is
a **fixture store** keyed by something already in hand, and the LLM is one
`ContentSource` that populates it. Hand-written fixtures and, later, recorded
real responses are other sources.

Resolution order (from §3):

```
override > fixture > spec example > seeded generator
```

**A fixture miss is never an error.** It falls through to seeded generation. The
mock cannot be broken by the LLM being slow, refusing, rate-limited, or absent.

### Storage

One JSON file per operation under `.mockingham/fixtures/`, keyed by request hash:

```json
{ "200": { "a3f19c2e": {
      "value": { "id": 42, "name": "Cara Whitfield", "bio": "…" },
      "meta": { "source": "llm", "model": "claude-opus-5", "schemaHash": "8b21…",
                "promptVersion": 3, "generatedAt": "2026-08-11T12:00:00Z" } } } }
```

Loaded into a Map at startup, written atomically (temp file + rename) with a
debounce. Human-readable and diffable on purpose: generated mock data becomes a
reviewed artifact you commit and hand-edit. `schemaHash` lets `bake` detect
staleness when the OpenAPI document changes and regenerate only affected fixtures.

### Modes

| Mode | LLM runs | For |
|---|---|---|
| `off` (default) | never | production, CI — serves whatever is on disk |
| `bake` | offline, via CLI or `mock.bake()` | populating the store |
| `lazy` | on cache miss, inline, timeout → seeded fallback | local dev |
| `live` | every request | demos, deliberate variance |

`bake` walks every operation × declared status (× named examples). Beyond a
configurable threshold it uses the Message Batches API — 50% cost, built for
non-latency-sensitive bulk work — with a concurrent single-call path for small
runs and for `lazy`.

### Contract-guaranteed output

The compiled zod schema goes straight into structured outputs, and the result is
parsed by that same schema:

```ts
const res = await client.messages.parse({
  model: 'claude-opus-5',
  max_tokens: 16000,
  system: [{ type: 'text', text: personaPrompt, cache_control: { type: 'ephemeral' } }],
  output_config: { format: zodOutputFormat(schemaForStatus(200)) },
  fallbacks: 'default',
  betas: ['server-side-fallback-2026-07-01'],
  messages: [{ role: 'user', content: promptFor(op, ctx) }]
})
```

Structured outputs do not cover all of JSON Schema, so three cases are handled
explicitly:

- **Numeric/string constraints** (`minimum`, `maxLength`, `multipleOf`) are
  stripped from the schema sent to the API and enforced client-side on parse. A
  violation triggers one retry, then falls back to seeded generation.
- **Recursive schemas** are unsupported; those operations skip the LLM entirely.
- **`stop_reason: 'refusal'`** is checked before reading content; server-side
  `fallbacks: 'default'` is enabled by default, and a refused chain falls back to
  seeded generation with a logged warning.

The system prompt is stable across a bake run and marked with `cache_control`, so
the persona and instructions are cached (512-token minimum on the default model).

### Prompt context

The prompt carries what the spec already knows and most tooling ignores:
operation `summary`/`description`, per-property `description` fields, resolved
path params (so `GET /users/42` gets `id: 42` right), any spec `example`, and a
user-supplied domain hint:

```ts
llm: {
  mode: 'bake',
  persona: 'B2B logistics SaaS, European customers, orders reference IMO vessel numbers',
  budget: { maxCalls: 500, maxConcurrency: 4, timeoutMs: 30_000 }
}
```

That domain grounding is what buys coherence — a user whose name, email, company
and bio belong to the same fictional person, which no amount of seeded randomness
produces.

### Scope

Default is **whole body** per (operation, status, request identity), for maximum
cross-field coherence. Narrowable when only prose matters:

```ts
llm: { scope: { byName: ['bio', 'description', 'notes'], bySchema: ['Address'] } }
```

Scoped fields come from the fixture store; everything else stays seeded and fast.

### Provider interface

```ts
interface ContentSource {
  generate(reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]>
}
```

Any provider is a small user-supplied function. The built-in Anthropic source
uses `@anthropic-ai/sdk` as an **optional peer dependency**, imported lazily only
when an LLM mode is configured. Users who never touch the LLM path install
nothing and the core stays zero-dependency; users who do get `messages.parse()`,
`zodOutputFormat`, the Batches client, and typed refusal/fallback handling
instead of ~400 lines of owned HTTP, batch polling, and retry logic. When an LLM
mode is set and the package is absent, startup fails with an explicit install
instruction.

---

## 15. MCP server

The primary consumer is an agent building a client against the mocked API. Two
problems follow, and the MCP server solves both.

**Context.** An OpenAPI document is usually far too large to hold in an agent's
context, and reading it wholesale to answer "what does `POST /orders` accept?"
wastes most of that budget. The MCP server turns the document into progressive
disclosure: the agent asks about the operation it is working on and gets exactly
that operation's contract, plus a real sample of what the mock will actually
return.

**Control.** The agent iterating on error handling needs the mock to produce a
503 on demand, or a specific field value, without editing config and restarting.

### Tools

Read — introspection over the loaded document:

| Tool | Returns |
|---|---|
| `list_operations` | method, path, `operationId`, summary, tags; filterable by tag or path prefix |
| `describe_operation` | params, request body schema, all declared response schemas, auth requirements, declared examples — for one operation |
| `search_operations` | operations matching a free-text query over path, summary, description, tags |
| `sample_response` | a **live generated response** for an operation/status, produced by the real pipeline — the exact bytes the agent's code will receive |
| `get_auth_requirements` | security schemes and per-operation requirements |
| `list_webhooks` | declared webhooks and callbacks, with payload schemas and which operations emit them |
| `list_deliveries` | what has been emitted so far — the agent's feedback loop for verifying its own handler |

`sample_response` is the one that earns its place: an agent writing a parser
against a schema is guessing, and an agent that has seen the concrete payload —
identical to what it will get at runtime, because determinism guarantees it — is
not.

Write — the control plane, exposed:

| Tool | Effect |
|---|---|
| `set_override` | pin a value at a path for an operation/status |
| `clear_overrides` | drop overrides, scoped or all |
| `fail_next` / `outage` | drive error paths on demand |
| `emit_webhook` | fire a webhook at a chosen URL — lets an agent test its own receiver without provoking the triggering flow |
| `set_seed` | reshuffle all generated content |
| `regenerate_fixture` | re-run the LLM for one operation |
| `reset` | clear chaos state, idempotency keys, counters, runtime overrides |

Write tools mutate only runtime state. They never edit the user's config file,
and `reset` fully restores the configured baseline — so an agent cannot leave the
mock in a state the developer did not ask for and cannot explain.

### Transport and dependency

Two ways to run it:

```sh
mockingham mcp ./openapi.json          # stdio — local agent tooling
```

```ts
mock.mcp({ transport: 'http', path: '/mcp' })   # same process and port as the mock
```

The HTTP transport is worth having because it collapses setup to one process: the
agent points at one URL for both the API it is mocking and the tools describing
it, and the mock it introspects is provably the mock it calls.

`@modelcontextprotocol/sdk` is an **optional peer dependency**, imported lazily
when the MCP server starts — the same pattern as the Anthropic source in §14.
Core stays zero-dependency; users who want MCP get a maintained protocol
implementation instead of ~200 lines of owned JSON-RPC that has to track a moving
spec.

---

## 16. Configuration surface

```ts
createMock(doc, {
  seed?: string
  chaosSeed?: string
  preferExamples?: boolean          // default true
  validateRequests?: boolean        // default true
  debugHeaders?: boolean            // default false
  errorBody?: 'contract' | 'diagnostic' | ErrorBodyFn
  maxDepth?: number                 // recursive schema cutoff, default 3
  baseUrl?: string
  store?: Store
  headers?: Record<string, HeaderValue>
  resolvers?: { byFormat?, byName?, bySchema? }
  operations?: Record<string, OperationConfig>
  auth?: Record<string, true | AuthSchemeConfig>
  failure?: FailurePolicy[]
  decide?: (ctx) => Directive | undefined
  idempotency?: IdempotencyConfig
  webhooks?: Record<string, WebhookConfig>
  captureOnly?: boolean             // default false
  llm?: LlmConfig
  mcp?: McpOptions
  onLog?: (record: LogRecord) => void | Promise<void>
  onError?: (err: unknown, ctx?) => void
})
```

Options are validated with zod at construction so a typo fails loudly and
immediately rather than silently doing nothing.

---

## 17. Testing

**`node:test`** with `node --test`, no test-framework dependency at all. Node
strips TypeScript natively, so tests are written in TypeScript and run directly
with no build step and no transpiler in the loop. `mvt` is dropped from
`devDependencies` — it predates the built-in runner and is TS-unaware.

Node floor is **≥24** (native type stripping unflagged, stable `node:test`,
`--experimental-test-coverage`); 26 is fine and nothing here depends on it. Type
stripping requires erasable-syntax-only TypeScript in `src/` and `test/`: no
`enum`, no `namespace`, no parameter properties. That is a constraint worth
accepting for the build-free loop, and good practice regardless — `const` objects
with `as const` replace enums cleanly.

- **Unit** per module: `$ref` resolution incl. cycles, route matcher precedence,
  PRNG determinism and distribution, each format producer, each constraint,
  override layering incl. async and wildcard, zod compilation for
  `allOf`/`oneOf`/discriminator, each pipeline stage in isolation, `MemoryStore`
  TTL, fixture store round-trip and staleness detection, runtime expression
  resolution, HMAC signature vectors, retry backoff sequencing.
- **Integration** through `mock.fetch()` against fixture specs: a petstore-ish
  document, an auth-and-idempotency-heavy document, and a deliberately nasty one
  (deep nesting, recursion, `oneOf` with discriminator, every format).
- **Adapter smoke test** through a real `node:http` port.
- **Determinism test**: the same request twice, across a fresh process, must be
  byte-identical.
- **Webhooks** tested in `captureOnly` mode end-to-end (subscribe via a real
  request carrying a callback URL, trigger the operation, assert the captured
  delivery), plus one real loopback delivery to a throwaway `node:http` receiver
  covering signing and retry. No outbound network in the suite.
- **LLM path** tested against a stub `ContentSource`; no network in the test suite.
- **MCP tools** tested by calling handlers directly, plus one stdio round-trip
  smoke test. `sample_response` is asserted to equal what `mock.fetch()` returns
  for the same operation — the two must never drift.

---

## 18. Implementation sequencing

Each phase leaves the project in a working, tested state.

1. **Foundations** — `spec/load`, `spec/refs`, `spec/routes`, `generate/rng`.
   Plus housekeeping: fix `"type": "esm"` → `"module"` in `package.json`, settle
   the `mockbox`/`mockingham` name mismatch, drop `mvt` and set
   `"test": "node --test"`, add `engines.node: ">=24"`, `.gitignore`, and
   `tsconfig.json` (`erasableSyntaxOnly`, `verbatimModuleSyntax`).
2. **Generation** — `schema/walk`, `generate/values`, `generate/constraints`.
3. **End-to-end minimum** — `server/handler`, `server/node`. Generates and
   responds. First integration test passes here.
4. **Overrides** — `resolve/layer`, `runtime/context`, `runtime/headers`,
   response callbacks.
5. **Validation and auth** — `schema/compile`, `runtime/validate`, `runtime/auth`,
   `runtime/errors`.
6. **Failure** — `runtime/failure`, `runtime/store`, control plane.
7. **Idempotency** — `runtime/idempotency`.
8. **Webhooks** — `webhooks/expr`, `webhooks/sign`, `webhooks/deliver`,
   `webhooks/emit`. Depends on generation, overrides, and the Store; nothing in
   phases 1–7 changes to accommodate it.
9. **Logging and CLI** — `runtime/logging`, `server/cli`.
10. **MCP server** — `mcp/tools`, `mcp/server`, stdio and HTTP transports.
    Read tools depend only on phases 1–3 and can land as soon as generation works
    if the consuming agent needs them sooner; write tools need phases 6 and 8.
11. **Fixtures** — `fixtures/store`, `fixtures/source`, `bake`, the Anthropic
    source, batch path.
12. **Docs** — README, a Datadog logging recipe, a fixture-workflow guide, a
    webhook-testing guide, and an MCP setup guide with a ready-to-paste client
    config.

---

## 19. Known limitations, stated up front

- **Corrected 2026-08-14 (phase 12 docs).** Regex `pattern` is not honored by
  value generation at all — not "a documented subset, warned at startup" as
  this bullet originally claimed. `pattern` appears nowhere in
  `src/generate/values.ts` or `src/generate/constraints.ts`, and no startup
  warning fires for it. Incoming requests ARE validated against a declared
  `pattern` (`src/schema/compile.ts`), so the two directions disagree: a mock
  can emit a body it would reject as a request. An override or fixture is the
  only way to get a pattern-conforming generated value. See
  `docs/superpowers/deferred-items.md` (item 28, phase 12).
- Recursive schemas terminate at `maxDepth` and are excluded from LLM generation.
- No stateful CRUD: writes do not affect later reads.
- YAML documents must be parsed by the caller and passed in as objects.
- `oneOf`/`anyOf` selection is seeded, not exhaustive; use `Prefer: example=` or
  an override to pin a specific variant.
- Webhooks fire only on explicit emit or a triggering operation. No recurring
  emitters, no chained deliveries, and retry state does not survive a restart.
- Runtime expression support covers a documented subset; expressions outside it
  warn at startup and fall through to the configured static URL.
