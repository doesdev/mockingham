# mockingham Phases 7 and 9 Design

**Status:** draft, awaiting approval.
**Covers:** §18 phases 7 (Idempotency) and 9 (Logging and CLI) of
`2026-08-11-mockingham-design.md`, which remains the master contract.

Like the phases 4–6 document, this records what the master spec left open and the
places where it must be amended. Where the two disagree, this wins for phases 7
and 9. Plans 1–4 delivered phases 1–6: a document loads, routes match, values
generate deterministically, overrides layer, requests validate, auth is enforced,
and the mock can fail on purpose. 408 tests.

---

## 1. The prerequisite refactor

**Phase 9 cannot be built on the current pipeline.** This is not a preference.

`src/server/handler.ts`'s `run()` has four `return` sites: the 404/405 path, the
body-parse failure, a stage short-circuit, and the rendered response. Logging must
observe **every** response — a 401 from auth and a 503 from chaos are exactly the
records an operator most wants — and there is no single place to hook it.

So plan 5's first task collapses `run()` to one exit, and gives each stage a named
factory colocated with its module so `handler.ts` only orders them. Design §2.3 of
the phases 4–6 document already specified the named sequence; the code has an
array of anonymous closures. That gap has been deferred twice and now blocks work.

**Amendment to the phases 4–6 design §2.3:** stages are registered as named
factories and executed through one loop, but the loop must produce a single exit
point through which every response passes. The original wording ("explicit
sequence — not a loop over an array") optimized for stack traces; a single
observation point matters more, and a named factory recovers the stack trace
anyway.

---

## 2. Amendments to the master spec

### 2.1 Log timestamps are outside the determinism invariant

§12's record carries `ts` and `durationMs`. Both need a wall clock, which
invariant 2 forbids in a generation path.

**They are permitted, because a log record is not a response.** The determinism
invariant governs response bytes: the same request must produce byte-identical
output across processes. A log record is an observational side channel that never
enters a response body or header. `ts` and `durationMs` therefore come from an
injected clock — the same pattern as `MemoryStore` — defaulting to `Date.now` at
the construction boundary only.

Tests inject a fake clock and assert exact durations rather than tolerating
jitter.

### 2.2 `requestId` is derived, not random

§12's record carries `requestId` and does not say where it comes from. A random id
would be the obvious choice and is wrong here: `requestId` is the natural value to
echo on a response header for correlation, and the moment it does, a random id
breaks the determinism invariant.

**`requestId` is `hash(requestKey, n)`** where `n` is a per-request-identity
ordinal — so it is stable across processes and distinct across repeated identical
calls. An inbound `X-Request-Id` header wins when present, because correlating
with the caller's id matters more than generating our own.

**`n` MUST come from its own counter, not the chaos counter.** Reusing the chaos
counter looks tempting — it is already keyed by `requestKey` and already
increments per call — but the failure stage increments it *per policy evaluation*,
and logging incrementing it too would shift every subsequent chaos roll. A run
would stop replaying identically the moment logging was enabled, which is exactly
the class of coupling the chaos seeding was designed to avoid. The request ordinal
is assigned once, when `ctx` is built.

### 2.3 The idempotency fingerprint hashes raw bytes

§11 says a replay with the same key but a different body fingerprint is a 409, and
does not say how the fingerprint is computed.

**It is `fnv1a` over the raw request bytes**, not over a re-serialization of the
parsed body. Re-serializing depends on key insertion order, which follows the
source text, so `{"a":1,"b":2}` and `{"b":2,"a":1}` would produce different
strings anyway — but only by accident, and a future canonicalization would
silently change which requests conflict.

Hashing raw bytes makes the rule explicit: **byte-identical bodies always replay;
anything else conflicts.** That errs toward a false conflict rather than a false
replay, which is the safe direction — a spurious 409 is visible and recoverable,
while a wrong replay silently returns someone else's response.

### 2.4 The in-flight marker must expire

§11 specifies a 409 `MOCK_IDEMPOTENCY_IN_FLIGHT` when a key is seen but no
response is stored yet. It does not say what happens if that request never
completes.

Without an answer the key wedges permanently: every retry sees an in-flight marker
that will never resolve. **The marker is written with its own short TTL** (default
30 seconds, configurable), *and* the handler's boundary catch clears it when a
request fails. Two mechanisms, because the TTL covers a process that dies mid
request and the catch covers a throw.

### 2.5 Stages record decisions on `ctx`

§12's record carries `decisions: { auth?, validation?, failure?, idempotency?, fixture? }`.
Stages currently return `Response | undefined` with no way to annotate anything.

**`ctx.decisions` is a plain object stages write into**, mirroring the existing
`ctx.log`. It is the minimal mechanism, needs no change to the `Stage` signature,
and keeps a stage's decision recorded even when it does not short-circuit — a
validation that *passed* is as loggable as one that failed.

---

## 3. Phase 7 — Idempotency

Idempotency spans **two** pipeline stages, which is why it is more invasive than
its size suggests: stage 5 looks up and stage 11 stores.

**Enablement.** Per §11, an operation is idempotent when the document declares an
`Idempotency-Key` header parameter, or when config names its method in
`idempotency.methods`. Config supplies the header name, TTL, scope, and conflict
status.

**The storage key** composes the configured `scope` parts in order — `key` (the
header value), `route` (the templated path, not the resolved one), and `bodyHash`
(§2.3). Using the templated path means `/pets/1` and `/pets/2` are different
routes only through their params, which are part of neither; that is deliberate,
since an idempotency key is supposed to be unique per logical operation.

**Stage 5** reads the record. A stored response replays with `Idempotent-Replay: true`
added. A fingerprint mismatch is a 409 `MOCK_IDEMPOTENCY_MISMATCH`. An in-flight
marker is a 409 `MOCK_IDEMPOTENCY_IN_FLIGHT`. Both go through `buildError`, so both
are on-contract per §7.

**Stage 11** stores `{ status, headers, body, fingerprint }`. The response body
must be captured as a string *before* the response is returned, because a
`Response` body is one-shot — reading it to store it would consume it. The single
exit point from §1 is where that capture happens.

## 4. Phase 9 — Logging and the CLI

**Logging** is stage 11, at the single exit. `onLog(record)` is invoked
fire-and-forget with error isolation: a throwing or rejecting logger must never
affect the response, which means an explicit `.catch()` rather than a bare
floating promise — an unhandled rejection can take a process down.

`bytesIn` is the raw request byte length, already available from body parsing.
`bytesOut` is the serialized response body length, available at the capture point.

`onError(err, ctx)` stays separate and covers internal faults, so an operator can
route the two differently.

**The CLI** (`src/server/cli.ts`) wraps `listen`. It is the first module allowed
to read `process.argv` and the filesystem, and stays out of the pure core. It
accepts a document path, `--port`, `--seed`, and `--watch`. YAML remains a
non-goal per the master spec: the CLI parses JSON and tells the user to pre-parse
YAML.

## 5. Testing

Per §17, plus:

- A fake clock throughout, so `durationMs` is asserted exactly rather than loosely.
- A replay test asserting the second response is byte-identical to the first
  *and* carries `Idempotent-Replay: true`.
- A fingerprint-mismatch test and an in-flight test, the latter driving the marker
  directly rather than racing two real requests.
- A test that the in-flight marker is cleared when a request throws — the wedge
  case from §2.4.
- A logging test asserting a record is emitted for a SHORT-CIRCUITED response
  (a 401), not only a rendered one. That is the case the refactor exists for.
- A throwing-logger test asserting the response is unaffected.

## 6. Known limitations

1. Idempotency records live in the `Store`, so they inherit its semantics —
   including that `reset()` currently clears a caller-supplied store wholesale.
   §1's refactor task settles that before records start living there.
2. `bytesOut` counts the serialized body only, not headers.
3. The CLI does not parse YAML.

## 7. What plan 6 picks up

Master spec phases 8 and 10–12: webhooks, the MCP server, fixtures and the LLM
content path, and the docs. Webhooks depend on generation, overrides, and the
Store, all of which now exist.
