# mockingham Phase 11 Design — Fixtures and the Content Path

**Status:** approved 2026-08-13; awaiting an implementation plan.
**Covers:** §14 and §18 phase 11 of `2026-08-11-mockingham-design.md`, which
remains the master contract. Where the two disagree for phase 11, this document
wins.

Plans 1–6 delivered phases 1–9: a document loads, routes match, values generate
deterministically, overrides layer, requests validate, auth is enforced, the mock
can fail on purpose, idempotent requests replay, webhooks and callbacks fire from
the single exit, every response is logged, and a CLI serves a document from the
command line. 600 tests, typecheck clean.

Like the phases 4–6, 7–9, and phase 8 documents before it, this one records what
the master spec left open and the places it must be amended. Writing it found
fourteen, one of which is not a correction but a restoration: the master spec
describes a provider interface and exactly one provider, and the
OpenAI-compatible wire format that the original brainstorm called for never made
it into any revision of the spec.

---

## 1. Scope

**Plan 7 is the whole of phase 11** — the fixture store, the resolution layer,
the bake driver, the provider interface, and three sources. The remaining phases
are 10 (MCP) and 12 (docs).

This is a larger plan than phase 8. It is designed as one subsystem with an
explicit internal ordering, so that if execution runs long it can be cut at a
seam rather than argued down mid-flight:

1. `key`, `store`, `persist` — the store, on disk, with nothing populating it.
2. `resolve`, `scope` — the resolution layer wired into the pipeline. At this
   point hand-written fixtures work end to end and the plan has standalone value.
3. `source`, the OpenAI-compatible source, `bake` — the default content path.
4. The Anthropic source and its batch path.
5. The recorded source.

Nothing in phases 1–9 changes to accommodate any of it beyond two additive
seams: `createResponders.generate` gains a fixture consultation, and
`renderResponse` gains one more body layer beneath the user's.

---

## 2. Amendments to the master spec

### 2.1 The fixture key excludes the root seed

§14 says the request-identity hash computed for the PRNG seed "doubles as a
content-addressed cache key". §3 defines that hash as `hash(rootSeed,
requestKey)`, and `server/handler.ts` builds it as
`${seed}|${method}|${path}|${sortedParams}`.

Reusing it verbatim means `new Mock(doc, { seed: 'ci-run-7' })` misses every
fixture on disk. The seed exists to vary *generated* content across runs; a baked
fixture is not generated content, and varying the seed must not silently stop the
mock from using reviewed data that is sitting right there.

The fixture key is therefore the request identity **without** the root seed —
method, templated path, resolved path params, and the configured query and header
contributors — hashed with the existing `fnv1a` to eight lowercase hex
characters, matching the `"a3f19c2e"` in §14's storage example. It is scoped per
operation and per status, so the key space per bucket stays small.

### 2.2 An OpenAI-compatible source is added, and is the default provider

§14 specifies a `ContentSource` interface, says "any provider is a small
user-supplied function", and then names exactly one built-in: Anthropic, via
`@anthropic-ai/sdk` as an optional peer dependency.

The OpenAI-compatible wire format — `POST {baseUrl}/chat/completions`, spoken by
Ollama, llama.cpp, vLLM, and LM Studio — is absent from every revision of the
master spec, including the first. It belongs here, and it fits the project's
constraints better than the Anthropic source does:

- **No dependency at all.** It is `fetch` and JSON. `zod` remains the only hard
  runtime dependency, and unlike the Anthropic source this one does not even need
  an optional peer dependency.
- **It reuses the injected `fetch` seam.** `options.fetch` already exists for
  webhook delivery. The source takes the same injected fetch, so it is tested at
  the wire level — real request shaping, real response parsing — while §17's
  "no network in the test suite" holds. The Anthropic source can only be stubbed
  one level up, at `ContentSource`.
- **It works offline**, which is the same posture as invariant 4.

It is the **default provider**. `provider: 'anthropic'` is opt-in, and §14's
"startup fails with an explicit install instruction" now fires only for that
provider. The common path needs no optional peer dependency.

### 2.3 `FixtureRequest` carries both schema representations

§14 defines `ContentSource` but never defines `FixtureRequest`, and its whole
structured-output story runs through `zodOutputFormat`. A request carrying only a
compiled zod type forces any non-Anthropic source to reach into zod internals to
recover a JSON Schema, which makes the interface provider-neutral in name only.

`FixtureRequest` carries **both**: the compiled zod schema (for the Anthropic
source's `zodOutputFormat`, and for client-side validation by any source) and the
plain JSON Schema for the response body. Both come from the existing
`schema/compile.ts` and the loaded document, so there is no second traversal and
no new dependency. The stated design goal, and a test asserts it: **a source for
another provider must be writable against the public `FixtureRequest` shape
alone, without importing zod or any mockingham internal.**

### 2.4 Batching is a source concern, not a driver concern

§14 puts the Message Batches threshold in the shared budget alongside `maxCalls`
and `maxConcurrency`. No local server has a batch endpoint, so a shared threshold
is meaningless for the default provider.

`ContentSource.generate` already takes an *array* of requests, which is the right
seam: how a source satisfies that array is its own business. The Anthropic source
uses the Batches API above its own configured `batchThreshold`; the
OpenAI-compatible source calls its endpoint sequentially, one request at a time,
deliberately not fanning out on its own. `bake`'s driver already owns
concurrency and its budget (`maxConcurrency`) at the `ContentSource.generate`
boundary — a source that ran its own bounded concurrency underneath that would
mean two layers each believing they control the fan-out, and `maxConcurrency`
would no longer describe the actual load a source puts on its endpoint.
`batchThreshold` moves out of the shared budget and into the Anthropic source's
configuration block.

### 2.5 `fallbacks` cannot be sent on the Message Batches API

§14's call sketch pairs `fallbacks: 'default'` with
`betas: ['server-side-fallback-2026-07-01']`, and separately says `bake` uses the
Batches API above a threshold. The `fallbacks` parameter is rejected on the
Batches API, so the two cannot be combined and the sketch would 400 on exactly
the path it was written for.

Only the single-call path carries `fallbacks: 'default'`. A refused batch entry
falls through to seeded generation like any other miss and is counted in the bake
summary.

### 2.6 Batch results are unordered and must be re-aligned

Message Batches results arrive in arbitrary order. `ContentSource.generate`
promises an array positionally aligned with its input, so the Anthropic source
keys each request by `custom_id` and re-aligns before returning.

This is called out as its own amendment because it is the one defect in this
subsystem that produces no error at all — it silently attaches the wrong body to
the wrong request, and every fixture is individually plausible. It gets a
dedicated unit test.

### 2.7 Thinking is on by default and shares `max_tokens`

§14's sketch sets `max_tokens: 16000` with no `thinking` field. On
`claude-opus-5` thinking is on by default and `max_tokens` caps thinking *plus*
response text together, so a large fixture body can truncate mid-object.

We keep thinking adaptive and set `output_config.effort` to `'low'` rather than
disabling thinking, which has its own documented failure modes. `max_tokens` is
sized for body plus thinking, not body alone.

### 2.8 `format` and `effort` are siblings in `output_config`

§14's sketch passes `output_config: { format: ... }` and omits `effort`
entirely, which leaves generation at the default effort. Both fields live in
`output_config` together:

```ts
output_config: { format: zodOutputFormat(schemaForStatus(status)), effort: 'low' }
```

### 2.9 Constraint stripping is the SDK's job

§14 says numeric and string constraints "are stripped from the schema sent to the
API and enforced client-side on parse", described as work we do. `zodOutputFormat`
already removes unsupported constraints and validates them client-side.

Hand-rolling it would duplicate that and risk diverging from what the API
actually accepts. Our only responsibility is the failure path: a client-side
constraint violation retries once, then falls through to seeded generation.

### 2.10 A null parse and a null `stop_details` are both normal

`messages.parse()` can return a null `parsed_output`, and `stop_details` can be
null on a genuine refusal. The Anthropic source branches on
`stop_reason === 'refusal'` before reading content, never on the presence of
`stop_details`, and treats a null parse as a miss rather than an error.

### 2.11 `live` mode is an explicit carve-out from invariant 2

§14 lists `live` as a mode without reconciling it against the determinism
invariant. It is the only deliberate exception in the project. It is documented
as such, and the determinism test names `live` as excluded rather than silently
not covering it. `off`, `bake`, and post-bake serving are fully deterministic;
`lazy` is deterministic once warm.

### 2.12 Lazy fetch is unavailable inside a full response callback

A full response callback (§4) runs before status selection, so there is no
selected status to resolve a fixture against and no point at which the pipeline
can await a source on its behalf. Inside a callback, `ctx.generate()` sees baked
fixtures — a store hit is synchronous — but never triggers a lazy fetch. A cold
lazy miss there falls through to seeded generation, which invariant 4 already
requires.

### 2.13 Stale fixtures warn; they are never rejected

§14 mentions `schemaHash` only for `bake` staleness detection and says nothing
about serving. Rejecting a stale fixture at runtime would silently discard
reviewed, committed, hand-edited data, which is the opposite of what §14 says the
store is for.

A `schemaHash` mismatch emits one startup warning naming the operation — the same
shape as §3's `pattern` warning, through the existing `onWarn` — and the fixture
is still served. `bake` is what regenerates it. Hand-written fixtures carry no
`meta` at all, so they are never stale and never warned.

### 2.14 §16 gains `llm.provider` and per-provider blocks

§16 lists `llm?: LlmConfig` without expanding it. Provider-specific options
(`baseUrl` for one, `batchThreshold` for the other) cannot share a flat
namespace without silently ignoring misplaced keys, which §16's own "a typo fails
loudly" rule forbids. The expanded surface is in §4 below.

---

## 3. Architecture

### Module layout

```
src/fixtures/key.ts                  fixture key derivation             pure
src/fixtures/store.ts                FixtureStore + in-memory impl      pure
src/fixtures/scope.ts                which paths a scoped fixture owns  pure
src/fixtures/resolve.ts              lookup and application             pure
src/fixtures/source.ts               ContentSource + request types      pure
src/fixtures/bake.ts                 bake driver                        pure
src/fixtures/persist.ts              load, atomic write, debounce       node only
src/fixtures/sources/openai.ts       default source, zero dependencies
src/fixtures/sources/anthropic.ts    optional peer dep, lazy import
src/fixtures/sources/recorded.ts     recorded upstream responses
```

`server/handler.ts` imports `key`, `store`, `scope`, and `resolve` only. It never
imports `persist` or any source; it receives a `FixtureStore` and an optional
`ContentSource` through options. Invariant 3 therefore holds by construction, and
the entire content path is stubbable without network.

### Storage

One JSON file per operation under `.mockingham/fixtures/`, keyed by status then
request hash, exactly as §14 specifies:

```json
{ "200": { "a3f19c2e": {
      "value": { "id": 42, "name": "Cara Whitfield", "bio": "…" },
      "meta": { "source": "openai-compatible", "model": "llama3.3",
                "schemaHash": "8b21…", "promptVersion": 1,
                "generatedAt": "2026-08-13T12:00:00Z" } } } }
```

Loaded into a Map at startup, written atomically (temp file plus rename) with a
debounce. `meta` is optional — a hand-written fixture is `{ "value": … }` and
nothing more. `generatedAt` comes from the injectable clock, not `Date.now()`.

### Resolution

After status selection, `resolveFixture()` runs once. It is async, so `lazy` and
`live` can await a source. It yields one of three outcomes, and the two
non-empty ones are applied differently:

- **nothing** — `generate()` behaves exactly as it does today.
- **a whole-body fixture** — returned at the `createResponders.generate` seam in
  place of `generateValue`, so no body is generated and discarded.
- **a scoped fixture** — passed to `renderResponse` as the first body layer,
  beneath the user's layers.

Precedence falls out without a new traversal. The scoped fixture is overlaid on
whatever `generate()` produced (a spec example or a seeded value), and the user's
override layers are applied after it:

```
override > fixture > spec example > seeded generator
```

`applyOverrides` already performs structured merging and already awaits promises
left in the tree by resolvers, so scope narrowing reuses it rather than growing a
second walk. This is the single most important structural decision in the
subsystem: a hand-written merge for partial fixtures is exactly where a second
schema traversal gets accidentally born, against invariant 1.

Responses with no body — 204 and anything with no JSON content — skip fixture
resolution entirely.

---

## 4. Configuration surface

```ts
llm?: {
  mode?: 'off' | 'bake' | 'lazy' | 'live'        // default 'off'
  provider?: 'openai-compatible' | 'anthropic'   // default 'openai-compatible'
  source?: ContentSource                          // wins over provider
  persona?: string
  scope?: { byName?: string[], bySchema?: string[] }
  budget?: {
    maxCalls?: number
    maxConcurrency?: number                       // default 4
    timeoutMs?: number                            // default 30_000
  }
  openai?: {
    baseUrl: string
    model: string
    apiKey?: string
    structuredOutput?: 'json_schema' | 'json_object' | 'none'  // default json_schema
  }
  anthropic?: {
    model?: string                                // default 'claude-opus-5'
    apiKey?: string
    batchThreshold?: number
  }
}
fixtures?: { store?: FixtureStore }
```

Validated with zod at construction like the rest of §16, so a key in the wrong
provider block fails loudly instead of doing nothing.

**`baseUrl` has no default in the core.** With an LLM mode set, no `source`, and
no `llm.openai.baseUrl`, construction fails with an explicit instruction. In
`off` mode — the default — no source is constructed and nothing is required.

**The CLI fills it in.** `server/cli.ts` resolves `baseUrl`, `model`, and
`apiKey` from the environment, defaulting `baseUrl` to
`http://localhost:11434/v1`, so `mockingham bake ./openapi.json` works for an
Ollama user out of the box. Environment reads stay in the CLI, never in the core.

**Structured output is declared, not probed.** `structuredOutput` says what the
server supports rather than the source discovering it, because a probe costs a
round trip on every cold start and its result is not deterministic. Whichever
mode is in use, the result is validated against the compiled zod schema
client-side.

---

## 5. Modes and the bake driver

| Mode | Source runs | Store writes | Determinism |
|---|---|---|---|
| `off` (default) | never | no | full |
| `bake` | offline, via `mock.bake()` or the CLI | yes | full (serving is `off`) |
| `lazy` | on a store miss, inline | yes | full once warm |
| `live` | every request | no | **none, by design** — see §2.11 |

**Lazy is single-flighted.** Concurrent identical requests share one in-flight
promise keyed by the fixture key, so a cold burst makes one call rather than N.
Unlike the known `MOCK_IDEMPOTENCY_IN_FLIGHT` gap this is genuinely solvable
here: one process, one Map, no store round-trip.

**One failure path.** A timeout, an exhausted budget, a refusal, a null result, a
constraint violation surviving one retry, and a source that throws all resolve
identically — fall through to seeded generation, record the reason, surface no
error to the caller. Sources are wrapped in try/catch by the driver; a throwing
source reaches `onError` and yields all nulls, mirroring how invariant 6 treats
emission.

**Bake** walks operations × declared statuses × named examples. It skips
operations with no JSON response content, and skips recursive schemas per §14 —
structured outputs do not support recursion. Error statuses are **not** skipped:
they have declared schemas under invariant 5, and a coherent on-contract error
body is worth generating. The driver reports a summary: generated, skipped,
refused, failed, and unchanged.

---

## 6. The provider interface and the three sources

```ts
interface ContentSource {
  generate(reqs: FixtureRequest[]): Promise<(FixtureResult | null)[]>
}
```

Positionally aligned. `null` is a miss, never an error. Implementations are not
required to be defensive — the driver wraps them.

**OpenAI-compatible (default, zero dependencies).** `POST
{baseUrl}/chat/completions` with the persona as a system message and the request
context as a user message. Under `json_schema` it sends
`response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`;
under `json_object` it sends `{ type: 'json_object' }` and carries the schema in
the prompt; under `none` it carries the schema in the prompt alone. It parses
`choices[0].message.content` and validates against the compiled zod schema in
every mode. `Authorization: Bearer` only when an `apiKey` is configured, so
Ollama needs none. It uses the injected `fetch` and an `AbortSignal` timeout.

**Anthropic (optional peer dependency).** `@anthropic-ai/sdk` imported lazily
inside the call, never at module top level. Uses `messages.parse()` with
`output_config: { format: zodOutputFormat(schema), effort: 'low' }`, a
`cache_control: { type: 'ephemeral' }` breakpoint covering the stable instruction
block and the persona together, and `fallbacks: 'default'` with beta
`server-side-fallback-2026-07-01` on the single-call path. Above `batchThreshold`
it uses the Message Batches API without `fallbacks` (§2.5), re-aligning results
by `custom_id` (§2.6).

Note that `claude-opus-5` has a 512-token minimum cacheable prefix. The stable
instruction block and the persona share one breakpoint so the combined prefix has
a chance of clearing it; caching is not promised for short personas.

**Recorded.** `createRecordedSource(entries)` answers from supplied upstream
responses. No network, no dependency.

The stub source used by the tests lives in `test/`, not `src/`, per §17.

---

## 7. Testing

Offline throughout, per §17.

- **Store** — round-trip, atomic write, debounce, missing `meta` tolerated,
  `schemaHash` mismatch warns once and still serves.
- **Key** — stable across a root-seed change (§2.1), varies with path params,
  varies with configured query contributors.
- **Resolution** — four-way precedence; a scoped fixture merges through
  `applyOverrides` with `generateValue` called exactly once; a whole-body fixture
  calls it exactly zero times; 204 skips resolution.
- **Determinism** — the same request twice across a fresh process with a baked
  store is byte-identical. `live` is named as excluded.
- **OpenAI-compatible source, at the wire** — against the injected `fetch`:
  `json_schema` request shape, `json_object` fallback, schema-in-prompt under
  `none`, malformed JSON retried once then seeded, HTTP 500 seeded, timeout
  seeded, `Authorization` present only with an `apiKey`.
- **Anthropic source** — stubbed at `ContentSource`, plus a dedicated unit test
  on `custom_id` re-alignment (§2.6) and one on refusal handling with a null
  `stop_details` (§2.10).
- **Interface neutrality** — a source implemented against the public
  `FixtureRequest` shape alone, importing no zod and no mockingham internal
  (§2.3).
- **Driver** — lazy single-flight proves two concurrent identical requests make
  one source call; budget exhaustion, refusal, recursive schema, and a throwing
  source all reach seeded generation; a throwing source reaches `onError`.
- **Bake** — walk coverage including error statuses, and the summary counts.

**Every one of these is verified by mutation before it is accepted** — break the
implementation, watch the test fail. This subsystem is unusually exposed to the
recurring defect of tests that cannot fail, because "falls through to seeded
generation" is also exactly what a test that is not wired up correctly does. A
fixture test that passes without the fixture ever being read looks identical to
one that works.

---

## 8. Known limitations, stated up front

- **The fixture key is 32 bits.** Collisions are possible in principle. The key
  space is scoped per operation and per status, which keeps each bucket small,
  and the store is a reviewed artifact where a collision is visible in the diff.
  Widening it is a one-line change if it ever bites.
- **`live` mode is not deterministic.** By design (§2.11).
- **Lazy fetch does not work inside a full response callback.** Baked fixtures
  do (§2.12).
- **A stale fixture is served, not corrected.** It can therefore be off-contract
  if the document changed under it. The startup warning is the signal; `bake` is
  the fix (§2.13).
- **`structuredOutput` is declared, not detected.** A server that claims
  `json_schema` support it does not have degrades to a validation failure and
  then to seeded generation, rather than to a clear error.
- **Recursive schemas never reach any source.** Per §14; they remain
  generator-only.

---

## 9. What plan 8 picks up

Phase 10 (MCP) and phase 12 (docs), in that order. The MCP read tools depend only
on phases 1–3; its write tools need phases 6 and 8, both of which have shipped.
Phase 12's fixture-workflow guide depends on this document.
