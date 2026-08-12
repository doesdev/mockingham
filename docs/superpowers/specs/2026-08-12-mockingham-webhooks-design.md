# mockingham Phase 8 Design — Webhooks and Callbacks

**Status:** draft, awaiting approval.
**Covers:** §18 phase 8 of `2026-08-11-mockingham-design.md`, which remains the
master contract. Where the two disagree for phase 8, this document wins.

Plans 1–5 delivered phases 1–7 and 9: a document loads, routes match, values
generate deterministically, overrides layer, requests validate, auth is enforced,
the mock can fail on purpose, idempotent requests replay, every response is
logged, and a CLI serves a document from the command line. 509 tests.

Like the phases 4–6 and 7–9 documents before it, this one records what the master
spec left open and the places it must be amended. Writing it found six.

---

## 1. Scope

**Plan 6 is webhooks alone.** The master spec's remaining phases — 8 (webhooks),
10 (MCP), 11 (fixtures and the LLM path), and 12 (docs) — are independent
subsystems with separate optional dependencies, and the spec itself states their
order: webhooks change nothing in phases 1–7; MCP's *write* tools need phase 8;
the docs describe all three. They get one plan each.

Phase 8 is self-contained. Nothing in phases 1–7 changes to accommodate it beyond
two additive hooks: the loader learns two OpenAPI fields, and the single exit
gains an emission trigger.

---

## 2. Amendments to the master spec

### 2.1 Signing uses WebCrypto, not `node:crypto`

§13 specifies HMAC-SHA256 "using `node:crypto`". Operation-linked emission fires
from the request pipeline, so the signing code is reachable from
`src/server/handler.ts` — and invariant 3 says the handler and everything it
imports must not touch Node APIs. Today `node:` appears in exactly two files,
`server/node.ts` and `server/cli.ts`, and that is worth keeping true.

**Signing uses the `crypto.subtle` global**, which is a web API like `Request`,
`Response`, and `TextEncoder` that the core already depends on. Verified
available unflagged in Node 24. Signing becomes async, which costs nothing
because delivery already is.

```ts
const key = await crypto.subtle.importKey(
  'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
)
const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${raw}`))
// x-mockingham-signature: t=<ts>,v1=<hex>
```

The header format, the signed string, and the algorithm are unchanged from §13 —
only the implementation moves.

### 2.2 Backoff jitter comes from the seeded PRNG

§13 specifies "jittered exponential backoff". Jitter is randomness, and
invariant 2 forbids `Math.random()`.

This is the same collision the chaos roller hit in phase 6, and it takes the same
resolution: **jitter is drawn from the seeded PRNG, keyed by webhook name and
attempt number.**

```ts
const rng = createRng(`${seed}|webhook|${name}|${attempt}`)
const base = Math.min(baseMs * 2 ** attempt, maxDelayMs)
const delay = Math.round(base * (0.5 + rng.next() * 0.5))
```

`baseMs` is the first retry's delay before jitter, defaulting to **250**. §13's
`retry` block does not name it, which would leave the doubling sequence
undefined; it is added to the config in §4. `backoff` accepts `'exponential'`
only — §13 names no other strategy, and a one-value union documents that a second
one is a deliberate addition rather than an oversight.

Keying by attempt rather than advancing one stream means a delivery's delay
sequence does not depend on how many other deliveries preceded it — the property
that makes a run replayable and a failing test reproducible. Tests assert the
exact sequence through the already-injectable `sleep`.

### 2.3 `mock.settled()` is added

§13 says emission "never blocks or delays the triggering response" and that
`afterMs` is a timer bound to the request's lifetime. Both are right, and
together they make an operation-linked emission unobservable: `fetch()` has
already resolved when the delivery happens, so a test has nothing to await.

Polling `deliveries()` with a timeout is the alternative, and it is how flaky
suites are made.

**`mock.settled()` drains the pending emission set.** The handler tracks
in-flight emissions; `settled()` awaits them all. With the injectable `sleep`, an
`afterMs` of 200 costs no real time in a test:

```ts
await mock.fetch(order)     // returns immediately, per §13
await mock.settled()        // drains pending emissions
assert.equal(mock.deliveries().length, 1)
```

`close()` cancels pending timers and `reset()` clears them — both already
required by §13's "canceled by `close()` and cleared by `reset()`".

### 2.4 Emit callbacks receive an `EmitCtx`, not `Ctx`

§13's operation-linked example is `body: { orderId: ctx => ctx.result.body.id }`,
but `Ctx` has no `result` and cannot sensibly gain one: it is constructed before
the response exists, so `result` would be `undefined` throughout every ordinary
resolver, header override, and response callback — a field that is only sometimes
real is a field that will be read when it is not.

**Emit override functions receive an `EmitCtx`**: the request `Ctx` plus the
finished response.

```ts
interface EmitCtx extends Ctx {
  result: { status: number; headers: Record<string, string>; body: unknown }
}
```

The response body is **already captured as a string at the single exit** for the
idempotency record and `bytesOut`; `result.body` reuses that capture rather than
reading the response a second time.

### 2.5 Retry classification, stated precisely

§13 says "Non-2xx responses retry, 4xx other than 408/429 do not." The second
sentence narrows the first rather than contradicting it, but the combination is
ambiguous enough to be implemented two ways.

**Retry on:** a network-level error, any 5xx, 408, and 429.
**Do not retry on:** any other 4xx, or any 2xx.
**3xx never reaches classification** — `fetch` follows redirects itself.

A non-retryable response ends the delivery immediately with its status recorded;
it is not an error and never throws.

### 2.6 Deliveries are captured and reported, not folded into `LogRecord`

§13 says webhook outcomes "record their outcome through §12 logging". But
`LogRecord` is request-shaped — `method`, `route`, `path`, `params`, `query`,
`decisions` — and §12 documents it as mapping directly onto Datadog/OTel-style
sinks. A delivery has none of those fields and has several of its own. Widening
the record with a discriminant would change a type every existing sink already
maps, to carry a shape that does not fit it.

**Every delivery is recorded in `deliveries()` regardless of mode, and a failure
reaches `onError`.** That satisfies what §13 wants — outcomes are observable
through the configured surfaces — without distorting §12's contract.

The capture log is **bounded at 1000 entries**, oldest dropped first, cleared by
`clearDeliveries()` and by `reset()`. A mock running for days must not leak, and
1000 deliveries inside one test is implausible. The bound is a documented
constant, not a config knob.

---

## 3. Architecture

Five new modules. Nothing existing imports them; the dependency arrow points one
way, from the handler into webhooks.

| Module | Responsibility |
|---|---|
| `src/spec/webhooks.ts` | Parse 3.1 top-level `webhooks` and per-operation `callbacks` into `Api`. `loadApi` ignores both today. |
| `src/webhooks/expr.ts` | The runtime-expression subset, and the startup warning for anything outside it. |
| `src/webhooks/sign.ts` | HMAC-SHA256 via `crypto.subtle` (§2.1). |
| `src/webhooks/deliver.ts` | One delivery: `fetch`, retry classification (§2.5), seeded backoff (§2.2), capture. Takes an injected `fetch` and `sleep`. |
| `src/webhooks/emit.ts` | Composes the rest: resolve destination → generate and layer the payload → sign → deliver. The only module `handler.ts` touches. |

**Emission reuses the existing machinery wholesale**, exactly as §13 intends:
payloads come from §3 generation, are shaped by §4 override layers, and carry
§5-layered headers. The genuinely new code is delivery, expression resolution,
and signing.

**The hook point is the single exit in `handle()`** — the seam plan 5 built.
Emissions register *inside* the exit's existing guard, so a throw anywhere in
emit, sign, or deliver reaches `reportError` and can never reach the response.
That guard exists because plan 5's whole-branch review found the store write had
been moved outside it; the same lesson applies unchanged here.

---

## 4. Configuration surface

Additive and entirely optional.

```ts
createMock(doc, {
  webhooks: {
    onOrderShipped: {
      url: 'http://localhost:5173/hooks/shipped',
      secret: process.env.HOOK_SECRET,
      retry: { attempts: 3, backoff: 'exponential', baseMs: 250, maxDelayMs: 10_000 },
      headers: { 'x-source': 'mockingham' }
    }
  },
  captureOnly: false,
  operations: {
    'POST /orders': {
      emits: [{
        webhook: 'onOrderShipped',
        afterMs: 200,                                  // or (ctx: EmitCtx) => ms
        body: { orderId: (ctx: EmitCtx) => ctx.result.body.id }
      }]
    }
  }
})
```

New instance surface, with the shapes stated so two readings are not possible:

```ts
interface Delivery {
  webhook: string
  /** Absent when nothing resolved — see §5 tier 4. */
  url?: string
  body: string                 // the serialized payload, as sent and as signed
  headers: Record<string, string>
  outcome: 'delivered' | 'failed' | 'captured' | 'unresolved'
  status?: number              // absent for 'unresolved', and for a network error
  attempts: number
  error?: string
}

mock.emit(name: string, opts?: { to?: string; body?: OverrideNode }): Promise<Delivery>
mock.deliveries(): Delivery[]        // oldest first, bounded per §2.6
mock.clearDeliveries(): void
mock.settled(): Promise<void>        // §2.3
```

`emit()` resolves with the `Delivery` rather than rejecting, in every case
including `unresolved` and an exhausted retry — §5's "an emit never hard-fails"
is a property of the return type, not merely of the implementation.

**`captureOnly` in light of §2.6.** Because deliveries are now always recorded,
`captureOnly` no longer controls *whether* capture happens — it controls whether
the delivery is **sent**. With `captureOnly: true` nothing leaves the process and
the outcome is `'captured'`; with `false` the delivery is attempted and the
outcome is `'delivered'` or `'failed'`. §13's "instead of, or alongside, sending
it" is resolved to: capture always, send unless `captureOnly`.

---

## 5. Destinations

Resolved in §13's precedence order:

1. An explicit `to:` on the `emit()` call.
2. A URL captured at runtime from a callback's OpenAPI runtime expression.
3. A static per-webhook `url` from config.
4. Nothing resolves → the delivery is captured but not sent, recorded
   `unresolved`. **An emit never hard-fails.**

**Supported expression subset:** `$url`, `$method`, `$statusCode`,
`$request.{header|query|path}.name`, `$request.body#/json-pointer`, and the
`$response.*` equivalents. Anything outside it warns at startup and falls through
to the next tier.

**Capture.** When a request reaches an operation declaring
`callbacks: { onOrderShipped: { '{$request.body#/callbackUrl}': {…} } }`, the
expression resolves against that live request and the URL is stored under
`callback|onOrderShipped`. A later `emit('onOrderShipped')` finds it. This is
what makes the common "client POSTs its own callback URL" flow work.

Keyed by callback name alone, so **a second subscriber replaces the first** — see
known limitations.

---

## 6. Testing

Per §17, plus the shapes this project has learned to distrust. Every trap below
is a test that passes against a broken implementation.

- **No outbound network in the suite.** `captureOnly` covers the end-to-end path
  with no receiver; exactly one real loopback delivery to a throwaway
  `node:http` receiver exercises signing and retry for real. Unit tests inject
  `fetch` and `sleep`.
- **Signing must use a known-answer vector** — fixed secret, fixed timestamp,
  fixed body, precomputed hex. A test asserting the header merely exists passes
  against any hash, including a wrong one.
- **Retry must assert the attempt count AND the exact delay sequence.** A test
  asserting "it retried" passes against a classifier that retries everything.
  §2.2's seeding makes the sequence a fixed list.
- **Capture must assert the delivered body validates against the webhook's
  declared schema.** `deliveries().length === 1` is true whether or not the
  payload conformed to anything, and conforming is the entire point of
  generating it from the document.
- **Determinism must compare across a fresh process**, not one process to itself,
  for both the payload bytes and the backoff sequence.
- **The `unresolved` path must assert the specific outcome and reason**, not that
  nothing threw.

---

## 7. Known limitations

1. **No fan-out.** A captured callback URL is keyed by callback name, so a second
   subscriber replaces the first. Fan-out needs a subscriber list and a delivery
   loop per subscriber; neither is in §13.
2. **No recurring emitters, no chained webhooks, no retry state surviving a
   restart.** Excluded by §13 on purpose — each needs a real scheduler, which is
   the one part of this feature that would reach into modules other than its own.
3. **The capture log is per-process.** Retry attempt state lives in the `Store`
   as §13 specifies, so it is shared when the Store is, but `deliveries()` is an
   in-memory ring buffer: `Store` has no enumeration primitive, and widening that
   interface for one caller was rejected when the same trade-off arose for
   `reset()`.
4. **The capture log is bounded at 1000 entries**, oldest dropped (§2.6).
5. **Emission is not transactional with the response.** A response is returned
   before its emissions complete, by design (§13). A process killed between the
   two loses the emission.

---

## 8. What plan 7 picks up

Master spec phase 11: fixtures and the LLM content path. Then phase 10 (MCP), whose
write tools depend on this phase, and finally phase 12 (docs).
