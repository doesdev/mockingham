# mockingham Phases 4–6 Design

**Status:** approved, ready for an implementation plan.
**Covers:** §18 phases 4 (Overrides), 5 (Validation and auth), and 6 (Failure) of
`2026-08-11-mockingham-design.md`, which remains the master contract.

This document does not restate the master spec. It records the decisions the
master spec left open, and the six places where it is internally inconsistent and
this design deliberately overrides it. Where the two disagree, this document wins
for phases 4–6; everywhere else the master spec stands.

Plan 1 delivered phases 1–3: a document loads, routes match, and a pure handler
returns seeded, schema-conforming responses. Phases 4–6 turn that into a mock you
can steer.

---

## 1. Amendments to the master spec

Each of these changes something the master spec states explicitly. They are
listed first so a reader who knows the master spec sees the deltas immediately.

### 1.1 The control plane is async

§1's instance surface declares `failNext(target, opts): void`, `outage(...): void`,
and `reset(): void`. §9 declares that all failure state lives in the `Store`, and
§10's `Store` is entirely async. A synchronous method cannot reliably write to an
async store: with `MemoryStore` the write happens to land in time, but against any
shared or remote store, a `failNext` immediately followed by a request races.

**Every control-plane method returns a `Promise`.** This includes `setSeed` and
`override`, which are in-process and would not strictly need it, so that callers
never have to remember which methods are which.

```ts
await mock.failNext('POST /orders', { times: 2, status: 500 })
await mock.outage('GET /users', { forMs: 5_000 })
await mock.reset()
```

### 1.2 `ctx.seq(name)` is synchronous and not Store-backed

§10's `Store.incr` is async, but §4's own example assigns the result directly:

```ts
body.id = ctx.seq('order')
```

That only works if `seq` is synchronous. Making it async would place a `Promise`
in every override leaf that uses a sequence number.

**`ctx.seq(name)` is synchronous, backed by an in-process counter map.** This is
the mirror image of 1.1 rather than a contradiction of it: chaos state is shared
across instances by design and is therefore async, while sequence counters are
per-instance identity and are therefore local. `reset()` clears them.

### 1.3 Runtime overrides do not cross instances

§9 states that all failure state lives in the `Store` so it works across a
multi-instance mock. `mock.override(target, value)` cannot honor the same promise:
override values may be functions, and functions do not serialize.

**Runtime overrides are in-process only.** `failNext` and `outage` are
Store-backed and do cross instances; `override` does not.

### 1.4 `Content-Length` is not set by mockingham

§5 lists `Content-Type` and `Content-Length` together as transport headers
computed last. Setting `Content-Length` by hand invites a mismatch with the
actual serialized body, and `Response` computes it correctly on its own.

**Only `Content-Type` is set from negotiation.** `Content-Length` is left to the
`Response` implementation.

### 1.5 404 is never on-contract

§7 states that when mockingham emits an error itself, it first looks for that
status in the operation's declared `responses`. A 404 from route matching has no
matched operation, so there is no contract to be on.

**404 and 405 always use the built-in envelope.** Every other self-emitted status
(400, 401, 403, 415, 429, 503) goes through the on-contract path.

**Amended 2026-08-12, during phase 6.** This clause originally listed 405 among
the on-contract statuses. That was wrong for the same reason 404 is exempt: a 405
means the path matched but the METHOD did not, so no operation was selected and
there is no operation whose error schema could apply. The operations that do exist
at that path are different operations, and generating a 405 body from one of their
schemas would attribute a contract to a request that never matched it. A 405 still
carries its `Allow` header and an error body; the body is simply the envelope.

### 1.6 Chaos rolls are seeded per invocation

§9 states only that "rate rolls are drawn from the seeded PRNG so a run is
reproducible." That admits three incompatible readings, and the choice is
observable in `rate`'s behavior. See §7.2 for the reasoning; the decision is that
each roll is seeded from `hash(chaosSeed, requestKey, n)` where `n` is a
per-`requestKey` invocation counter.

---

## 2. Architecture

### 2.1 New modules

| Phase | Modules |
|---|---|
| 4 | `runtime/body.ts`, `runtime/context.ts`, `resolve/target.ts`, `resolve/layer.ts`, `runtime/headers.ts` |
| 5 | `schema/compile.ts`, `runtime/validate.ts`, `runtime/auth.ts`, `runtime/errors.ts` |
| 6 | `runtime/store.ts`, `runtime/failure.ts` |

`resolve/target.ts` is not in the master spec's module layout. Target strings
(`'GET /orders/*'`, `'* /users/{id}'`, a bare `operationId`) are needed by
`operations` keys, `failure[].match`, and the control plane alike, so they get one
home: a function compiling a target string into an operation predicate, validated
at construction so a target matching no operation throws immediately.

### 2.2 Existing files that change

- **`src/spec/types.ts`** - gains `SecurityScheme`, a `security` field on
  `Operation`, and `securitySchemes` plus `schemaNames` on `Api`.
- **`src/spec/refs.ts`** - emits a `Map<Schema, string>` recording which
  `components.schemas` name each resolved schema object came from. See §4.2.
  This is a **signature change**: `resolveDocument` currently returns
  `Record<string, unknown>` and must return the document plus the name table.
  Its existing tests and `load.ts` update with it, and that migration is a task
  in its own right rather than a side effect of the `bySchema` work.
- **`src/spec/load.ts`** - parses `securitySchemes` and `security`, including the
  document-root default. The loader currently discards both entirely, so auth has
  nothing to enforce until this lands.
- **`src/server/handler.ts`** - becomes a stage orchestrator.
- **`src/index.ts`** - async control plane.

### 2.3 The pipeline

Stages run in the master spec's §2 order. Every stage has the same shape:

```ts
type Stage = (ctx: Ctx) => Promise<Response | undefined>
```

Returning a `Response` short-circuits; returning `undefined` continues. `handler.ts`
calls them in explicit sequence - not a loop over an array, so the order
typechecks and a stack trace names the stage that responded.

| # | Stage | After plan 2 |
|---|---|---|
| 1 | Route match | done in plan 1 |
| 2 | Body parse / content negotiation | new - `runtime/body.ts` |
| 3 | Auth | new - `runtime/auth.ts` |
| 4 | Request validation | new - `runtime/validate.ts` |
| 5 | Idempotency lookup | gap, plan 3 |
| 6 | Failure policy | new - `runtime/failure.ts` |
| 7 | Status selection | extended: `Prefer: example=`, per-operation override |
| 8 | Generate body + headers | extended: header layering |
| 9 | Apply override layers | new - `resolve/layer.ts` |
| 10 | Full response callback | new |
| 11 | Store result, emit log | gap, plan 3 |

Stages 5 and 11 are deliberate gaps. The pipeline is written so plan 3 inserts
them without disturbing their neighbors.

### 2.4 The context object

`ctx` is constructed once, after body parsing, and threaded through every
subsequent stage. Its surface is §4's, with `seq` synchronous per 1.2:

`req`, `params`, `query`, `headers`, `body`, `auth`, `seq(name)`, `store`, `rng`,
`schema.request()`, `schema.response(status)`, `example(status, name?)`,
`generate(status)`, `respond(status, body?, headers?)`, `deny(status, code?)`, `log`.

---

## 3. Phase 4 - Body parsing

Stage 2 handles content negotiation and parsing, per §2 of the master spec:
`application/json`, `application/x-www-form-urlencoded`, and `text/*` are parsed;
anything else is exposed as raw bytes on `ctx.body` and skipped by validation. A
content type the operation does not declare produces 415; a malformed body of a
declared type produces 400.

This stage must exist before `ctx` can be built, which is why phase 4 owns it even
though the master spec's §2 discusses it under the pipeline generally.

---

## 4. Phase 4 - Overrides

### 4.1 Two mechanisms, split by what they key on

The four override sources in §4 look like one feature but divide on a line that
invariant 1 of `CLAUDE.md` forces rather than merely suggests.

**`byFormat`, `byName`, and `bySchema` are schema-keyed.** They need the format,
property name, and originating component name at each leaf. Applying them after
generation would require walking the schema alongside the generated value - a
second schema traversal, which invariant 1 forbids outright. They are therefore a
**resolver hook consulted inside `generate.ts`**, at leaves the existing walk
already visits.

**`operations[...].body` is value-keyed.** It is a shaped overlay addressing
object keys, array indices, and `'*'`. It needs no schema knowledge at all, so it
is a **value-tree overlay in `resolve/layer.ts`** applied on top afterward, and
traverses no schema.

Precedence falls out of that ordering rather than needing separate enforcement:

```
operations  >  bySchema  >  byName  >  byFormat  >  generated
(overlaid last)  (consulted during generation, in this order)
```

`byName` is an ordered list and the first matching entry wins, so specific
patterns are placed before general ones. Patterns are globs by default and accept
a `RegExp`.

### 4.2 The schema-name side table

`bySchema: { User: … }` keys on a component name, but after `$ref` resolution a
schema object no longer records that it came from `components.schemas.User`.

Resolution already makes every reference to `User` the *same object*, so identity
is enough: `resolveDocument` emits a `Map<Schema, string>` alongside the resolved
document, populated from the `components.schemas` entries it already walks. This
adds no traversal - it records what resolution already knows - and lands on the
`Api` model as `schemaNames`.

### 4.3 Async leaves

Overlaying is a two-pass walk. Pass one applies overrides and records every
`Promise`-valued leaf with its path. Pass two performs a single `Promise.all` and
writes the settled values back.

A body with fifty async overrides therefore costs one tick rather than fifty, as
§4 requires. A function returning a plain value is used directly and never
touches the promise list.

### 4.4 Full response callback

`respond` replaces stages 7 through 10 for its operation. It receives `ctx` and
returns a `Response`, typically via `ctx.respond(status, body?, headers?)`. The
`ctx.generate(status)` and `ctx.schema.response(status)` helpers let a callback
produce a seeded body and validate its own output against the declared schema.

---

## 5. Phase 4 - Headers

`runtime/headers.ts` layers response headers in §5's order, increasing
precedence, later layers overwriting earlier:

1. Headers declared in the operation's response object, generated from their schemas.
2. Global `headers` defaults from config.
3. `byName` resolvers.
4. Per-operation header overrides.
5. Transport headers, computed last and never overridable - `Content-Type` from
   negotiation only, per amendment 1.4.

When `debugHeaders` is on, `x-mock-seed`, `x-mock-operation`, and
`x-mock-status-source` are added alongside the transport headers, and
`x-mock-error` carries the diagnostic for on-contract errors (§7).

---

## 6. Phase 5 - Validation, auth, errors

### 6.1 Schema compilation

`schema/compile.ts` compiles an OpenAPI schema to a zod schema **through
`classify()`** - the same interpretation generation uses. This is the whole point
of invariant 1: what we generate and what we validate read the schema once, one
way, and cannot drift.

Compilation is memoized in a `WeakMap` keyed on resolved-schema object identity,
so a `User` referenced by twenty operations compiles once. Recursive schemas
compile through `z.lazy()`.

The compiler serves three consumers: request validation, `ctx.schema.*` in
response callbacks, and construction-time validation of user-supplied config.

### 6.2 Request validation

`validateRequests` defaults to `true`. Path params, query params, headers, and
body are validated against the operation's declared schemas, producing 400 with a
flattened error list:

```json
{ "code": "MOCK_REQUEST_INVALID",
  "errors": [{ "path": "body.age", "message": "Expected number, received string" }] }
```

Path and query values arrive from the wire as strings. They are **coerced per
their declared schema before validation**, per §2 - without which every `{petId}`
declared `integer` would fail against a compiled `z.number()`.

### 6.3 Auth

`runtime/auth.ts` enforces `securitySchemes` and per-operation `security` by
default. A missing or malformed credential produces 401; unmet declared scopes
produce 403; both in the operation's own error shape per §7.

Three OpenAPI semantics here are easy to invert, and each gets a test:

- `security` is an array of requirement objects. It is **OR across the array, AND
  within each object** - any one requirement object satisfied is sufficient, but
  every scheme named inside that object must be satisfied.
- A document-root `security` is the **default** used when an operation declares
  none.
- `security: []` on an operation means **no auth required**, which is meaningfully
  different from an absent `security` field.

Supported scheme types are `http` (bearer, basic), `apiKey` (header, query,
cookie), and `oauth2`/`openIdConnect`, the last two treated as bearer with scope
checking. A scheme with no `auth` entry gets a presence and shape check derived
from the document. The principal returned by `verify` lands on `ctx.auth`.

### 6.4 On-contract errors

`runtime/errors.ts` is consulted by every stage that emits a status itself. It
looks the status up in the matched operation's declared `responses`, generates
from that schema when present, and falls back to the built-in envelope otherwise.
404 is the exception, per amendment 1.5.

`errorBody` defaults to `'contract'`. In that mode the diagnostic remains
available on `x-mock-error` when `debugHeaders` is on, so a contract-shaped 400 is
still debuggable.

---

## 7. Phase 6 - Store, failure, control plane

### 7.1 Store

`runtime/store.ts` provides §10's `Store` interface and a `MemoryStore` with TTL
support. TTL needs a notion of time, and invariant 2 requires an injectable clock,
so `MemoryStore` accepts `now: () => number` and defaults to `Date.now` at the
construction boundary only. Expiry is lazy, evaluated on read. The module imports
nothing from `node:`, since the pure handler reaches it.

### 7.2 Failure

`runtime/failure.ts` is stage 6, evaluating in §9's order: `decide()` → one-shot
`failNext` → outage → circuit state → rate → latency. Latency applies even when
the request succeeds.

**Chaos seeding.** §9 requires only that "a run is reproducible," which admits
three readings with materially different behavior:

| Approach | Reproducible | Problem |
|---|---|---|
| One chaos RNG stream advanced per request | Serial runs only | Outcome depends on how many requests preceded it, so it breaks under concurrency and when a test runs in isolation |
| Seed from request identity alone | Yes | The same request always passes or always fails, turning `rate: 0.05` into "5% of distinct endpoints" rather than "5% of calls" |
| **Seed from `hash(chaosSeed, requestKey, n)`** | **Yes** | - |

The third is chosen. `n` is a per-`requestKey` invocation counter held in a
synchronous in-process map. Repeated identical calls vary as `rate` implies, a
fresh instance replays a run exactly, and the increment is atomic under a
single-threaded runtime, so concurrent requests cannot interleave into
nondeterminism. `chaosSeed` defaults to `seed`, and setting it separately varies
chaos independently of content.

**Latency takes an injectable sleep.** A real `p99: 800` would otherwise make the
suite wait 800ms per test. Tests inject a recording no-op and assert the requested
duration.

**Circuit state** (`{ after, openFor, then }`) lives in the Store via `incr` and a
TTL'd key, and therefore uses the same injected clock.

### 7.3 Control plane

All methods return promises, per amendment 1.1:

```ts
override(target: string, value: Override): Promise<void>   // in-process only, 1.3
failNext(target: string, opts: FailNextOptions): Promise<void>
outage(target: string, opts: OutageOptions): Promise<void>
setSeed(seed: string): Promise<void>
reset(): Promise<void>
```

`reset()` clears chaos state, sequence counters, and runtime overrides. Targets
are validated through `resolve/target.ts`, so an unmatched target throws rather
than silently doing nothing.

---

## 8. The determinism boundary

Invariant 2 of `CLAUDE.md` reads as absolute. It needs one clarification, because
phases 4–6 introduce user callbacks that can be arbitrarily nondeterministic:

**The byte-identical guarantee covers values mockingham generates.** A user
override of `() => new Date()` or `ctx.seq('order')` is nondeterministic by
construction and by the user's explicit choice. The invariant constrains
mockingham's own generation path - it does not, and cannot, constrain
user-supplied functions.

Nothing in mockingham's generation path may use `Math.random()` or `Date.now()`;
that part of the invariant is unchanged and still enforced by grep.

---

## 9. Testing

Per §17, with three additions specific to this plan:

- **Unit, per module.** Override layering including async and wildcard nodes, zod
  compilation for `allOf`/`oneOf`/discriminator/recursion, target-string matching,
  `MemoryStore` TTL against a fake clock, each pipeline stage in isolation - which
  is what the uniform stage signature is for.
- **The plan-1 determinism check stays green.** Generated output must not shift
  merely because override machinery now sits in the path. This is a regression
  guard on the whole plan.
- **Chaos reproducibility.** Identical request sequences against two fresh
  instances produce identical failure patterns.
- **Auth semantics.** Explicit tests for OR-across / AND-within, the root-level
  default, and `security: []` versus absent `security`.

---

## 10. Known limitations

1. Runtime overrides do not cross instances, because functions do not serialize
   (amendment 1.3).
2. Chaos reproducibility is per request-sequence, not per isolated request - a
   request's failure outcome depends on how many times that same request was made
   since the last `reset()`.
3. Pipeline stages 5 (idempotency) and 11 (logging) remain gaps until plan 3.
4. Everything the master spec lists in §19 still applies.

---

## 11. Definition of done

- `npm test` passes with every test file green.
- `npx tsc --noEmit` reports no errors.
- `grep -rn "from 'node:" src/spec src/schema src/generate src/resolve src/runtime src/server/handler.ts` returns nothing.
- `grep -rn "Math.random\|Date.now()" src/generate src/schema src/resolve` returns
  nothing. Plan 1 ran this against all of `src/`; it is narrowed here because
  `MemoryStore` legitimately defaults its injected clock to `Date.now` at the
  construction boundary (§7.1). The generation path itself stays clean, which is
  what the invariant is about. `runtime/` is excluded for that one call site
  only; every other `runtime/` module must take the clock rather than read it.
- The plan-1 cross-process determinism check still produces byte-identical bodies.
- Every stage in §2.3 marked "new" or "extended" has an isolation test.

---

## 12. What plan 3 picks up

Pipeline stages 5 and 11: idempotency (`runtime/idempotency.ts`) and logging
(`runtime/logging.ts`), plus the CLI. Phases 8 and 10–12 of the master spec's §18
(webhooks, MCP, fixtures, and docs) follow from there.
