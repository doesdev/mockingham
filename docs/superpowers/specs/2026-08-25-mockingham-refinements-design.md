# mockingham — refinements delta design (plan 11)

2026-08-25. A delta against the master spec
(`2026-08-11-mockingham-design.md`), covering seven refinements proposed after
running the server against a document that leans on registered webhook
destinations, create-then-read loops, and discriminated response unions.

Read this document's §2 before any of §3–§9. Two of the seven proposals turn
out to be one mechanism, and that is the single most consequential finding
here.

---

## 1. Scope

Seven items, all in. The proposal document tiered them; that tiering is
preserved below as a label but does not affect scope — everything ships.

| § | Item | Proposal tier |
|---|---|---|
| 3 | Cross-operation webhook destination registry | 1.1 |
| 4 | Response linking for create-then-read loops | 1.2 |
| 5 | `Prefer: variant=` and the `set_variant` tool | 2.1 |
| 6 | Idempotency key from a body pointer | 2.2 |
| 7 | Redelivery on demand, and delivery identity | 2.3 |
| 8 | UUIDv7 generation from a seeded virtual clock | 3.1 |
| 9 | Exposing which operations recall versus generate | 3.2 |

### 1.1 Out of scope, deliberately

**Honoring `pattern` in value generation** (deferred item 28). §8's proposal
was written believing a UUIDv7 `pattern` "generates correctly under the
documented subset" and lacks only chronology. It does not generate at all:
`pattern` appears nowhere in `src/generate/values.ts` or
`src/generate/constraints.ts`, while `src/schema/compile.ts` compiles it into
the zod validator requests are checked against. The two directions disagree,
which is invariant 1's failure mode showing up in a place invariant 1 does not
reach — one traversal, but only one of its two consumers reads the keyword.

Fixing it means a regex-to-string generator: a real subsystem, with its own
supported-construct subset, its own startup-warning surface for constructs
outside that subset, and a fresh opportunity for generation and validation to
drift on exactly the schemas where agreement matters most. That is a design
cost, not merely a work cost, and it is the one thing on this list that would
be reckless to fold into a cycle already carrying seven items. It stays as
item 28. §8 ships `format`-based recognition, which is orthogonal to it and
does not depend on it.

This is called out because a reader who knows the proposal document will
expect §8 to close the UUID gap completely. It does not, and the reason is not
oversight.

---

## 2. The finding that shapes this cycle: §3 and §4 are one mechanism

The registry (§3) and response linking (§4) read as unrelated features — one
is outbound webhooks, the other is inbound request correlation. They are the
same three steps:

1. After a response is final, evaluate a runtime expression against the
   request *and* the response.
2. Store the resolved value under a key derived from the operation and an
   optional scope.
3. Later, read it back on a different request or emission.

All three steps already exist in the codebase, for one narrow case. Callback
destination capture — "destination tier 2" — does exactly this at
`src/server/handler.ts:799-819`: it waits for a final response with a status
below 400, builds an `exprInput` carrying both request and result, resolves
each declared callback expression, and writes the result to
`store.set(callbackKey(name), value)`. `src/webhooks/emit.ts:115` reads it back
at emission time.

So the honest description of §3 and §4 is not "two new subsystems." It is:
**generalize the existing tier-2 capture block from one hardcoded expression
source (a document's `callbacks` entries) to a configured list of capture
rules, and give the stored values two readers instead of one.**

This collapses the work substantially and, more importantly, means the two
features cannot drift apart. They share:

- `resolveExpression` and `ExprInput` (`src/webhooks/expr.ts`) — unchanged.
- The `exprInput` construction at the single exit — extracted to a named
  helper, since three call sites will now build it instead of one.
- The `status < 400` precondition and its rationale, quoted at
  `handler.ts:794-798`: a 401 has not subscribed to anything, and capturing
  from one would let an unauthenticated caller redirect another tenant's
  webhooks. That reasoning applies verbatim to a registration and to a link
  record.
- One capture pass over one rule list, so the ordering between a registration
  write and a link write is defined by config order rather than by which
  feature's block happens to run first.

**Design consequence.** A new module, `src/runtime/capture.ts`, owns the rule
list and the capture pass. §3 and §4 each contribute rule kinds to it; neither
owns the pass. `handler.ts`'s tier-2 block becomes one call into it, with the
document's `callbacks` entries compiled into rules of a third kind at
construction, so the existing behavior travels through the new path rather
than sitting beside it.

That last point matters and is the riskiest edit in the cycle. It is called
out again in §12.

---

## 3. Cross-operation webhook destination registry (proposal 1.1)

### 3.1 What the document does

Registration is a dedicated operation, not a URL supplied on the triggering
call:

```
PUT    /subscriptions/order-events    { "url": "https://consumer.example/hook" }
DELETE /subscriptions/order-events
```

A later `mock.emit('orderStatusChanged')` delivers to whatever that `PUT`
stored. `DELETE` unregisters; emissions afterward have nowhere to go.

### 3.2 Why today's four tiers do not reach it

`emitWebhook` resolves in order (`src/webhooks/emit.ts:114-116`): explicit
`to`, a captured callback URL, a configured `url`, then nothing. The captured
tier is written only from a `callbacks` expression evaluated inside the
triggering request. There is no path by which one operation writes a
destination another operation's emission reads, and no scoping axis at all —
`callbackKey(name)` is keyed by webhook name alone.

### 3.3 Configuration

```ts
createMock(doc, {
  webhooks: {
    orderStatusChanged: {
      registerVia:   { operationId: 'setOrderSubscription',
                       url: '{$request.body#/url}' },
      unregisterVia: { operationId: 'deleteOrderSubscription' },
      scopeBy:       '{$request.header.x-tenant-id}'
    }
  }
})
```

`registerVia.operationId` accepts any control-plane target string, not only an
operationId — `compileTarget` (`src/resolve/target.ts:24`) already parses
`'PUT /subscriptions/{name}'`, `'* /subs/**'`, and a bare operationId, and
`resolveTarget` already throws on a target matching nothing. Reusing it means
a typo fails loudly at construction, consistent with every other target in the
system. The field keeps the name `operationId` from the proposal for
familiarity but its documented type is "a control-plane target".

Note the brace syntax. `src/webhooks/expr.ts` resolves `{$request.body#/url}`,
with braces — the proposal document wrote `$request.body#/url` bare. Bare
forms are accepted and normalized by wrapping, because OpenAPI's own
`callbacks` keys are written bare and a reader coming from the spec will type
it that way. Both spellings resolve identically; this is stated in the docs.

### 3.4 Storage and scope

```
registration|<webhook name>|<scope>
```

with `<scope>` the resolved `scopeBy` value, or the empty string when
`scopeBy` is absent. Store-backed, following the `failNext` and override
precedent, so `reset()` clears registrations for free via `store.clear()` and
a shared Store shares them across processes.

`scopeBy` falls out of the same expression evaluation as `url` and is close to
free, as the proposal argues. Its real justification is different and worth
recording: without it, a document that partitions registrations per tenant has
every tenant overwriting one key, so the second tenant's registration silently
redirects the first tenant's webhooks. That is not an inconvenience to work
around later; it is a wrong answer that looks like a working mock.

An emission resolves its scope the same way — but an emission triggered by
`mock.emit()` has no request to evaluate an expression against. Three cases:

- **Operation-linked emit** (an `emits` config firing at the single exit):
  the triggering request is in hand, so `scopeBy` resolves normally.
- **`mock.emit(name, { scope })`**: an explicit scope string wins over any
  expression, exactly as `to` wins over any resolved destination.
- **`mock.emit(name)` with a `scopeBy` configured and no explicit scope**: the
  scope resolves to the empty string, which addresses the unscoped
  registration. If none exists, the emit is `unresolved` — see §3.6.

### 3.5 Runtime surface

```ts
mock.registrations(name?): Promise<Registration[]>
mock.register(name, url, scope?): Promise<void>
mock.unregister(name, scope?): Promise<void>
```

`Registration` is `{ webhook: string; url: string; scope: string }`.

`registrations()` returns entries **sorted by `webhook` then `scope`**.
Invariant 2 forbids letting an unordered iteration decide anything observable,
and this method is observable — through the API, through the MCP read tool in
§9, and through anything a test asserts on. The `Store` interface has no
enumeration primitive (`src/runtime/store.ts:1-7`), which is the same wall
`createDeliveryLog` hit and solved by keeping an in-process index
(`src/webhooks/emit.ts:63`). The registry does the same: the Store holds the
authoritative value, an in-process `Set` holds the known keys for enumeration,
and `registrations()` reads through to the Store for each key so a
shared-Store write from another process is still reflected in the value even
though the key list is process-local. That asymmetry is a documented
limitation, identical in kind and rationale to the delivery log's.

### 3.6 What an emission with nothing registered does

The proposal flags this as "worth deciding explicitly," and suggests dropping
with observability via a counter or `onError`.

**Invariant 6 already decides it.** "An emit that resolves no destination is
captured as `unresolved`, not an error." A registry with nothing registered is
precisely an emit that resolved no destination, so it produces a `Delivery`
with `outcome: 'unresolved'` and no `url`, recorded in `deliveries()` like any
other. Routing it to `onError` instead would contradict the invariant.

The proposal's underlying worry — that a silent drop is indistinguishable from
a delivery that failed elsewhere — does not apply: `unresolved` is already a
distinct outcome from a failure, and `Delivery.status` and `Delivery.error`
are both documented as absent for it (`src/webhooks/deliver.ts:19-22`). The
observability the proposal asks for exists; nothing is needed.

This is recorded at length because "the invariant already answers it" is a
better outcome than a new mechanism, and because a future reader will
otherwise re-open the question.

### 3.7 Destination tier order

The registry becomes a new tier, between explicit and captured:

1. explicit `to`
2. **registration for the resolved scope**
3. captured callback URL
4. configured `url`
5. nothing → `unresolved`

Above the captured tier because a registration is a deliberate, persistent
statement about where a webhook goes, while a captured callback URL is
incidental to whichever request last happened to carry one. A document using
both is unusual; when it does, the explicit registration should win.

---

## 4. Response linking for create-then-read loops (proposal 1.2)

### 4.1 What it is, and what it is not

A write's generated response is recorded against a key extracted from that
response. A later read whose key matches replays the recorded bytes. A read
with no matching key generates normally.

That is the entire feature. No mutation, no partial update, no lifecycle, no
delete semantics, no list endpoint that reflects what was created. The master
spec's non-goals list "stateful CRUD persistence" and this does not become
one: the claim is only that **an identifier the mock itself minted resolves to
the thing it minted it for.**

### 4.2 Configuration

```ts
createMock(doc, {
  link: [{
    from:     { target: 'createOrder', key: '{$response.body#/id}' },
    to:       { target: 'getOrder',    key: '{$request.path.id}' },
    remember: '{$response.body}'
  }]
})
```

`remember` defaults to `'{$response.body}'` and may be omitted. `from.target`
and `to.target` are control-plane targets, resolved by `resolveTarget` at
construction, so a typo throws rather than silently never linking.

A subtlety: `remember: '{$response.body}'` must record the response body as a
**value**, not as the string `resolveExpression` returns. `resolveToken`
funnels `body` through `scalar()` (`src/webhooks/expr.ts:45-49,79`), which
returns `undefined` for an object — so the bare `{$response.body}` template
resolves to a failure today, not to the body. The capture pass therefore
special-cases a `remember` that is exactly `{$response.body}` or
`{$request.body}` and takes the parsed value directly, using
`resolveExpression` only for pointer forms that address a scalar. This is a
genuine sharp edge and is why `remember` has a default: most callers never
write it.

### 4.3 Storage, bounds, and eviction

```
link|<rule index>|<key value>
```

Keyed by rule index rather than by operation, so two rules recording under the
same extracted key value do not collide.

**A recall table is unbounded by construction** — every `POST` mints a new id
and adds an entry. Two bounds, both required:

- `link[].ttlMs`, default 3,600,000 (one hour). Store TTLs are already lazy
  and per-entry (`src/runtime/store.ts:33-37`), so this is free.
- `link[].max`, default 1000, matching `MAX_DELIVERIES`'s precedent as a
  documented constant rather than an open-ended knob. Oldest key evicted
  first, tracked by the same in-process index the registry uses.

Without both, a long-lived mock under load leaks until the process dies. This
is the kind of thing that is invisible in a test suite and obvious in
production, so it is specified rather than left to the implementer.

### 4.4 Where the replay happens in the pipeline

The recall read happens at **stage 7.5**, immediately after status selection
and immediately before the fixture resolves — that is, right at
`handler.ts:569`, where `fixtureResolver.resolve` is awaited today.

Recall produces a value that behaves exactly like a fixture layer: it sits
**beneath** the config and runtime override layers and above generation. The
resulting precedence chain is:

```
runtime override > config override > link recall > fixture > example > generated
```

Link recall above fixture because a recalled entity is more specific than a
fixture for the operation — the fixture answers "what does this endpoint
return", the recall answers "what does this endpoint return *for this id*".

Only a **success** status recalls. A recall replaying its stored body into a
404 or a 500 would be actively wrong, and the failure-injection stage exists
precisely so a caller can force those.

### 4.5 The invariant 2 problem, stated plainly

Invariant 2 says the same request must produce byte-identical output across
processes. Linking makes a `GET /orders/{id}` response depend on whether a
`POST /orders` ran earlier in the same process against the same Store.

**Amendment.** Invariant 2 is refined to: *the same request sequence produces
byte-identical output across processes.* Determinism was always
sequence-scoped in fact — request ordinals feed `requestIdFor`, the webhook
counter feeds emission seeds, idempotency records replay prior responses, and
`failNext` consumes armed failures in order. Every one of those already makes
a response depend on what came before it. Linking adds another such
dependency; it does not introduce the category.

What must remain true, and what the tests must prove: replaying an identical
sequence of requests against a fresh process with the same seed produces
identical bytes at every step. That is the honest form of the invariant and
the one `scripts/determinism.ts` was always exercising.

This amendment is the single most important line in this document. A future
reader who finds linking and reads invariant 2 literally will conclude the
feature violates it.

---

## 5. `Prefer: variant=` and `set_variant` (proposal 2.1)

### 5.1 Selection

`src/generate/generate.ts:70-71` is today
`walk(rng.pick(kind.variants), depth + 1)`. It becomes: if a variant name is
in effect and some branch's discriminator value matches it, walk that branch;
otherwise `rng.pick` unchanged.

`classify` already extracts `discriminator: schema.discriminator?.propertyName`
(`src/schema/walk.ts:130`) and generation ignores it today. A new pure helper
beside `classify` — schema interpretation belongs in `walk.ts`, invariant 1 —
determines a branch's name:

- With a formal `discriminator`, read that property on the branch and take its
  value when `classify` reports `kind: 'const'`.
- Without one, a branch matches when **any** of its const-valued properties
  equals the requested name. This covers the
  `outcome: { const: conflict }` shape, which carries no `discriminator`
  object and is the common case.

Refs are resolved at load (`src/spec/load.ts:1` → `resolveDocument`), so
variants arrive as real schemas and `discriminator.mapping` needs no handling.

### 5.2 Unmatched falls through; it does not fail

Precedent is explicit at `src/runtime/select.ts:35-37`: "An undeclared Prefer
status falls through to the normal choice rather than failing." A variant name
matching no branch takes the seeded pick. This also makes the directive
harmless on a response with no union in it.

**The proposal's construction-time warning is dropped.** It cannot work: the
name arrives in a request header, so construction has nothing to check it
against. Warning at runtime on every non-match would fire constantly for the
many responses that contain no union at all. Silent fall-through is the honest
behavior, and it matches the sibling directive.

### 5.3 Scope of one directive

The name applies at every union in the tree. A nested union with a matching
branch takes it; one without falls back to seeded. No path targeting, no
per-union syntax — a second addressing scheme for schema positions would be a
new concept, and the value it buys is small.

### 5.4 Wiring, and where it deliberately does not go

`GenerateOptions` gains `variant?: string`. `handler.ts` reads it beside the
existing example directive (`preferred(request, 'variant')`, near line 430)
and threads it into the `generateOptions` given to `createResponders`.

The other three `generateOptions` construction sites do **not** receive it:

- `runEmit` (`handler.ts:284`) — an emitted webhook has no request, so no
  `Prefer` header.
- `failWith` (`handler.ts:318`) — steering an error envelope's union from a
  request header is not a behavior to introduce silently.
- the header builder (`render.ts:57`) — same reasoning.

### 5.5 `set_variant`, which does not come along for free

The proposal states this reuses "the same target resolution as the override
tools, so it comes along as an MCP write tool for free." It does not. The
override tools work through `resolveTarget` against **stored runtime state**;
`Prefer` is a per-request header with nothing stored behind it.

`set_variant` is therefore a genuine addition: a stored, per-operation variant
preference, following plan 10's runtime-override pattern exactly.

```
variant|<targetKey>
```

Resolution order at generation time:

1. `Prefer: variant=` on this request
2. the stored `set_variant` value for the resolved operation
3. seeded pick

Per-request beats stored, for the same reason `Prefer: status` beats a
configured status: a header is a statement about *this* call.

Surface:

```ts
mock.setVariant(target, name): Promise<void>
mock.clearVariants(target?): Promise<void>
```

plus `set_variant` and `clear_variants` MCP write tools, mirroring
`set_override` / `clear_overrides` — including the `clear_overrides` detail
that the no-target case echoes `null` rather than `'*'`, because a bare `'*'`
is not a valid target and echoing it teaches a caller a string that throws on
its next call.

Write-tool count goes from seven to nine; `mcpTools({ write: true })` from
fourteen to sixteen, before §7's and §9's additions. The pinned tool inventory
test moves accordingly — see §10.

---

## 6. Idempotency key from a body pointer (proposal 2.2)

### 6.1 The gap

`isIdempotent` (`src/runtime/idempotency.ts:85-92`) recognizes an operation as
idempotent only when the document declares the configured header as a header
parameter, or when config names its method. Plenty of documents put the key in
the body — `meta.requestId`, `messageId`, `eventId` — and instruct consumers
to deduplicate on that field.

### 6.2 The proposal's dependency claim is wrong, in a useful direction

The document says this "reuses the pointer-expression evaluation from 1.1 and
1.2, so once either of those lands this is mostly plumbing," and lists it as
optional on that basis.

`resolveExpression` already evaluates `{$request.body#/meta/requestId}` today
(`src/webhooks/expr.ts:75-80`) and imports nothing webhook-specific. This item
depends on neither §3 nor §4 and could have shipped at any point in the last
five plans. It is the smallest real item on the list, not a dependent one.

### 6.3 Configuration

```ts
idempotency: {
  operations: {
    deliverOrderEvent: { key: '{$request.body#/meta/requestId}' }
  }
}
```

Keys are control-plane targets, resolved at construction. An operation with a
configured key is idempotent regardless of what the document declares —
`isIdempotent` gains a third sufficient route, joining the declared-header and
configured-method routes, and the existing "either route is sufficient,
neither wins" rule at `idempotency.ts:80-84` extends unchanged.

### 6.4 Ordering constraint

The idempotency stage is **stage 5**; the body is parsed at **stage 2**
(`trace.bytesIn = parsed.body.raw.length`, `handler.ts:428`). A body pointer
therefore has a parsed body available by the time it is evaluated. Confirmed
against the pipeline order rather than assumed — an expression evaluated
before its source exists is exactly the class of defect this repo's delta
designs exist to catch.

When the pointer resolves to nothing — a body missing the field — the request
is **not** idempotent and proceeds normally, matching the existing behavior
for a missing header (`idempotency.ts:160-162`: "No key, nothing to key on").

`recordKey`'s `scope` composition is untouched. A body-pointer key is a `key`
part like any other; `bodyHash` continues to mean "a different body under this
key is a conflict" and continues not to enter the key, for the reason recorded
at `idempotency.ts:22-28`.

There is one interaction worth stating: with the default scope including
`bodyHash`, a body-pointer key is *inside* the body it is fingerprinted
against. Two requests with the same `requestId` and any other field differing
conflict with `MOCK_IDEMPOTENCY_MISMATCH` — which is correct and is what a
document instructing "deduplicate on `meta.requestId`" means.

---

## 7. Redelivery on demand, and delivery identity (proposal 2.3)

### 7.1 Not the small item it is listed as

`Delivery` (`src/webhooks/deliver.ts:11-23`) has no id field. There is no
`deliveryId` to redeliver *by*. The proposal's one-line surface —
`mock.redeliver(name, deliveryId)` — requires first inventing delivery
identity, which is a contract addition to a type that already appears in
`deliveries()`, in the `emit_webhook` tool's return, and in the webhooks
guide.

### 7.2 Delivery identity

`Delivery` gains `id: string`, derived deterministically:

```
fnv1a(`${seed}|delivery|${webhook}|${ordinal}`)
```

where `ordinal` is the existing per-webhook counter already feeding the
emission rng (`handler.ts:283`). Deterministic, so a replayed request sequence
produces the same delivery ids — required by §4.5's amended invariant 2, and
the reason this is not a UUID.

**One id per emission, not per attempt.** A retry sequence is one delivery
with `attempts: n`, which is how `Delivery` already models it. This is exactly
the property the proposal wants observable: a redelivery carries the same
identifier as the first attempt.

### 7.3 Redelivery

```ts
mock.redeliver(id): Promise<Delivery>
```

Keyed by id alone — the webhook name is recoverable from the record, and a
two-argument form that could disagree with itself is a defect surface for no
benefit. This diverges from the proposal's `redeliver(name, deliveryId)`
deliberately.

Redelivery re-sends the recorded bytes: same body, same signature header, same
destination, same id. It does **not** regenerate the payload, and it does not
re-resolve the destination — the point is to prove that a duplicate carries
the same identity, and regenerating would defeat it. The returned `Delivery`
is a new record with the same `id`, appended to the log.

A signature is reused rather than recomputed. `sign` takes a timestamp
(`emit.ts:139`), so recomputing would produce a different signature header for
identical bytes — which is a real behavior in production systems but is not
what "identical bytes, identical ids" asks for. The recorded header is
replayed verbatim.

An unknown id throws, consistent with `emitWebhook`'s treatment of an unknown
webhook name (`emit.ts:107-112`): a name or id that is not in the log is a
typo, and the surrounding surfaces fail loudly on those.

An id whose delivery has aged out of the 1000-entry log also throws, with a
message naming the bound. Silently succeeding with nothing to send would be
worse.

`redeliver_webhook` joins the write tools.

---

## 8. UUIDv7 from a seeded virtual clock (proposal 3.1)

### 8.1 The gap, restated correctly

`generateString`'s `uuid` case (`src/generate/values.ts:51-54`) hardcodes
version 4 — literal `4` in the version position, `[89ab]` in the variant
position. Values are well-formed v4 UUIDs and carry no time ordering.

UUIDv7 (RFC 9562) exists so identifiers sort by creation time, and sorting by
id is the property people reach for once they adopt it. Anything exercising
ordering against the mock behaves unlike production.

See §1.1 for why the `pattern`-based route in the proposal is out of scope;
this section is `format`-based only.

### 8.2 Recognition

Two routes:

- `format: "uuid7"`, and the RFC-adjacent spellings `uuidv7` and `uuid-v7`,
  normalized. `format` is an open string in JSON Schema, so this is a legal
  extension rather than a redefinition.
- `x-mock-format: "uuid7"` on a schema whose `format` is the plain `uuid`,
  for documents that cannot change `format` without breaking another
  consumer's validation.

`x-mock-format` wins when both are present.

### 8.3 Generation, and the determinism problem

A v7 UUID is a 48-bit millisecond timestamp, then version `7`, then 74 bits of
randomness. The timestamp is the whole point and is also the whole problem:
reading a real clock inside a generation path violates invariant 2 outright.

**A seeded virtual clock.** A per-mock counter, starting at `seedTime`,
advancing by a fixed step on each v7 generated. Monotonic within a run,
identical across runs on the same seed, so ids sort by generation order and
determinism is preserved rather than traded away.

```ts
createMock(doc, { seedTime: 1735689600000 })   // 2025-01-01T00:00:00Z
```

Default `seedTime` is a fixed epoch constant, **not** `Date.now()` — a default
that reads the wall clock would make baked fixtures unstable across runs,
which is the exact failure `seedTime` exists to prevent. The default is
declared as a named constant beside the generator.

The step is 1 ms per generated v7. A fixed step rather than a seeded jitter
keeps "sorts by generation order" exactly true rather than probably true.

**The virtual clock is per-mock, not per-request.** It advances across
requests, which is what makes ids from successive `POST`s sort correctly — and
which makes v7 generation another sequence-dependent output under §4.5's
amended invariant 2. Same sequence, same ids. `reset()` returns the counter to
`seedTime`, matching how `reset()` treats every other counter.

The 74 random bits come from the existing seeded PRNG, unchanged.

---

## 9. Exposing which operations recall or register (proposal 3.2)

Once §3 and §4 exist, a mock has operations that recall and operations that
generate, and a consumer cannot tell which from outside. That difference is
the difference between an operation a workflow can be built against and one
that will quietly not round-trip.

Three surfaces, all read-only:

- **`describe_operations`** gains, per operation: `linksFrom` / `linksTo` (the
  rule indices it participates in), `registersWebhook` / `unregistersWebhook`
  (webhook names), and `idempotencyKey` (the resolved source: a header name, a
  body pointer, or absent).
- **`list_webhooks`** gains `registry`: whether the webhook has a registry
  configured, and how many registrations currently exist. Not the URLs —
  a registered destination is a consumer's endpoint and does not belong in a
  capability listing that an agent may log.
- **A new `list_registrations` read tool**, which does return URLs, because
  asking for them explicitly is a different act from having them appear in a
  capability dump.

`GET /__mock/capabilities` from the proposal is **not** built. An HTTP admin
control plane is a stated non-goal of the master spec ("Non-goals (v1)"), and
adding one endpoint to the request surface would put a reserved path in front
of every document — including documents that legitimately define `/__mock/*`.
The MCP read tools reach the same information without that cost.

While `read.ts` is open, the three residuals recorded as deferred item 29
(a: `findOperation` ignoring `method`/`path` alongside `operationId`;
b: `list_webhooks` dropping a callback's declaring operation from `emittedBy`;
c: `payloadSchema` bypassing the `$comment` fallback) are fixed. Their
deferral ruling was explicitly "fix belongs to whoever next opens
`src/mcp/tools/read.ts`", and this cycle is that.

---

## 10. MCP tool inventory

| Tool | Kind | Status |
|---|---|---|
| `set_variant` | write | new, §5.5 |
| `clear_variants` | write | new, §5.5 |
| `redeliver_webhook` | write | new, §7.3 |
| `register_webhook_destination` | write | new, §3.5 |
| `unregister_webhook_destination` | write | new, §3.5 |
| `list_registrations` | read | new, §9 |
| `describe_operations` | read | extended, §9 |
| `list_webhooks` | read | extended, §9 |

Read tools 7 → 8. Write tools 7 → 12. `mcpTools({ write: true })` 14 → 20.

The tool inventory test is pinned by design (commit `13c012b` strengthened it
precisely so an accidental addition or removal fails). It is updated
deliberately as part of this cycle, and the count above is the expected
value — an implementer finding a different number has found a defect, not a
stale test.

---

## 11. Determinism review

Every item, against invariant 2 as amended by §4.5.

| Item | Sequence-dependent? | Same sequence → same bytes? |
|---|---|---|
| §3 registry | Yes — a registration changes later destinations | Yes; registration is a pure function of the registering request |
| §4 linking | Yes — by construction | Yes; recall replays recorded bytes |
| §5 variant | No | Yes; a pure function of the header and the schema |
| §6 body-pointer idempotency | Yes — already true of idempotency | Yes; unchanged mechanism, new key source |
| §7 delivery ids | Yes — ordinal-derived | Yes; `fnv1a` over seed, name, ordinal |
| §8 uuid7 | Yes — virtual clock advances | Yes; counter is seeded and stepped fixed |
| §9 exposure | No | Read-only |

Two things that would break determinism and are therefore forbidden, stated so
an implementer does not reach for them: `Date.now()` anywhere in §8's clock,
and iteration over the registry's or link table's key `Set` for anything
observable without sorting first (§3.5).

---

## 12. Risk: the tier-2 refactor

§2 folds the existing callback-capture block into a general capture pass. That
block is at the single exit, inside the guard added by plan 6's fix wave for
deferred item 22, and the master lesson from plan 5 is recorded in
`deferred-items.md` as: *"A refactor can move code out of a safety net without
touching the net."* Plan 5 shipped a Critical defect of exactly this shape at
exactly this location.

Constraints on that task, which are non-negotiable:

- The capture pass runs **inside** the existing `try`/`catch`, not beside it.
- The `status < 400` precondition is preserved with its comment.
- Existing callback-capture tests must pass **unmodified**. If a test needs
  changing, the refactor changed behavior and is wrong.
- The task ships with an end-to-end test through `mock.fetch` proving a
  document's `callbacks` destination still resolves after the refactor — the
  lesson from plan 7 being that per-task review cannot see a seam defect, only
  an end-to-end test through the public surface can.

---

## 13. Known limitations

1. **Registration enumeration is process-local.** The Store holds
   authoritative values; the key index does not cross processes. Identical in
   kind to the delivery log's limitation (§3.5).
2. **The link table is bounded** at 1000 entries and one hour. A sequence
   exceeding either recalls nothing for the evicted keys and falls through to
   generation, which is a silent behavior change from the caller's view (§4.3).
3. **`pattern` remains ignored by generation** (deferred item 28, §1.1). A
   UUIDv7 expressed only as a `pattern` still generates a non-conforming
   value; `format` or `x-mock-format` is required.
4. **Redelivery cannot reach a delivery evicted from the 1000-entry log**, and
   throws rather than silently succeeding (§7.3).
5. **`set_variant` and `Prefer: variant=` do not reach webhook payloads or
   error envelopes** (§5.4).
6. **A `remember` expression addressing a non-scalar via a pointer** — say
   `{$response.body#/items}` — resolves to a failure and records nothing,
   because `resolveExpression` funnels through `scalar()`. Only the whole-body
   forms are special-cased (§4.2).
