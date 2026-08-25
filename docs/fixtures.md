# The fixture workflow

A **fixture** is a reviewed, committed response body sitting on disk, keyed by
operation, status, and request identity. It exists so a mock can serve content
that reads like a real domain - a coherent name, a plausible bio, a currency
code the reader recognizes - without giving up the property that makes a mock
worth trusting: **a fixture or LLM miss is never an error. It falls through to
seeded generation** (`CLAUDE.md`, invariant 4). The LLM being slow, absent, or
refusing never breaks the mock; it only means that particular response looks
seeded instead of hand-crafted.

Resolution order is:

```txt
override > fixture > spec example > seeded generator
```

A fixture only ever adds coherence on top of what generation already
guarantees. Nothing downstream needs to know whether a body came from disk or
from the seeded generator.

## The four modes

`llm.mode` controls when, if ever, a content source runs:

| Mode | When the source runs | Typical use |
|---|---|---|
| `off` (default) | never | production, CI - serves whatever is on disk |
| `bake` | offline, via the CLI or `mock.bake()` | populating the fixture store |
| `lazy` | on a store miss, inline, with a timeout that falls back to seeded generation | local dev |
| `live` | on every request | demos, deliberate variance |

`off`, `bake`, and serving a baked store are fully deterministic. `lazy` is
deterministic once warm. `live` is the one deliberate exception to the
determinism invariant - it is not covered by it, and reaching for it means
accepting that.

## Local model first

The built-in default provider speaks the OpenAI-compatible wire format
(`POST {baseUrl}/chat/completions`) against `http://localhost:11434/v1` - an
Ollama server on your machine. No API key, no signup, and it is what the CLI
defaults to, so baking against a local model needs no configuration beyond
having Ollama running:

```sh
ollama serve
```

```sh
ollama pull llama3.3
mockingham bake ./openapi.json --fixtures ./fixtures --model llama3.3
```

`bake` walks every operation and every declared response status, sends each
one to the source, and writes whatever comes back to `--fixtures` (default
`.mockingham/fixtures` if you omit the flag).

## Baking without a model

The example below uses `createRecordedSource` instead of a live model, so it
runs offline and deterministically - which is also why it is the one piece of
this guide that is actually executed rather than merely described:

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

```console
{
  "generated": 1,
  "skipped": 0,
  "failed": 5
}
```

The example document declares six operation/status pairs with a JSON body:
`listPayments` 200, `createPayment` 201 and 422, `getPayment` 200 and 404, and
`createRefund` 202. The recorded source above only has an entry for
`getPayment` 200, so that is the one `generated` fixture - the rest have
nothing to answer them and land in `failed`. `skipped` is 0 here because every
one of those six responses has a JSON body the walk can turn into a request; a
204, a response with no `application/json` content, or a recursive schema
would count there instead.

`BakeSummary` has exactly three fields, and the distinction between the last
two is the part worth understanding:

- **`generated`** - a fixture was written to the store.
- **`skipped`** - never attempted: no JSON body to bake against, a recursive
  schema (structured outputs can't express one), or an operation the call
  budget cut off before it was reached.
- **`failed`** - attempted, but no fixture came out of it: the source
  returned `null`, threw, or (once scoped) narrowed to nothing worth keeping.
  `ContentSource.generate` returns `FixtureResult | null` with no reason
  attached, so a source's outright refusal is indistinguishable from any
  other kind of miss at this boundary, and both land in `failed`.

A real bake run against a live model would have far fewer `failed` results -
this one is mostly `failed` because the recorded source above was deliberately
given only one answer, not because baking is unreliable.

## Serving what you baked

Fixtures are plain JSON files, one per operation, meant to be reviewed like
any other change and committed. Once they're in, point the server at the
directory instead of (or as well as) baking again:

```sh
mockingham ./openapi.json --fixtures ./fixtures
```

Requests for `getPayment` now return the recorded payment; everything else
still generates, exactly as it did before any fixture existed.

## The staleness warning

A fixture's metadata records a hash of the response schema it was generated
against. If the OpenAPI document changes under a fixture - a field added, a
type changed - the hash no longer matches, and startup prints one warning per
affected operation, naming it and saying the fixture may no longer match the
document.

This is diagnostic only. **A stale fixture keeps serving** - nothing rejects
it, and nothing silently discards reviewed, hand-edited data just because the
document moved. Re-running `bake` is what actually regenerates it. A
hand-written fixture (one with no `meta` at all) is never stale by this check
and never warns, because there is nothing to compare it against.

## Regenerating one operation

Re-baking a whole document to refresh one response is a poor trade when a
source charges per call. `bake()` takes a scope - one operation, and
optionally one of its statuses. Continuing the program above, whose recorded
source can only answer `getPayment` 200:

```ts
const scoped = await mock.bake({ only: { operationId: 'getPayment', status: 200 } })
console.log(JSON.stringify(scoped))
```

```console
{"generated":1,"skipped":0,"failed":0}
```

No `failed` this time. The five responses the recorded source has no answer
for were never planned, because the scope excluded them - which is the whole
point when a live model is charging for each one. A scope can also name the
operation by route instead:

```ts
const byRoute = await mock.bake({ only: { method: 'get', path: '/payments/{id}' } })
console.log(JSON.stringify(byRoute))
```

```console
{"generated":1,"skipped":0,"failed":1}
```

That one covers both of `getPayment`'s declared statuses, because no `status`
narrowed it: 200 is regenerated, and 404 is **`failed`** rather than `skipped` -
it has a JSON body, so the walk planned it and asked the source, and the
recorded source had no answer. `skipped` would mean it was never attempted at
all.

Everything else about a scoped run is unchanged: the same `persona`, `scope`,
and `budget` a full bake would use, and the same `schemaHash` and
`generatedAt` written into the entry's metadata. **Regenerating is what clears
the staleness above.**

**A scope that matches no operation throws**, rather than returning a summary
of zeroes. A summary saying `generated: 0` for a mistyped `operationId` reads
as "there was nothing to do", which is the opposite of what happened. A scope
that matches an operation with nothing bakeable - no JSON body, a recursive
schema, a range response key - is *not* an error, and is reported as
`skipped`.

`mock.fixtures()` returns everything in the store, which is how you see what a
bake actually landed:

```ts
for (const record of mock.fixtures()) {
  console.log(`${record.operationId} ${record.status}`)
}
```

```console
getPayment 200
```

Both of these are exposed over MCP, as `regenerate_fixture` and
`list_fixtures` - see `docs/mcp.md`. `list_fixtures` reports a `stale` flag per
entry, computed the same way the startup warning is, so an agent can find what
needs regenerating without restarting the mock.

## Scope, persona, and budget

By default a fixture is the **whole response body**, for maximum cross-field
coherence - a name, an email, and a bio that all plausibly belong to the same
person. `llm.scope` narrows that to specific fields when only prose needs
help and the rest of the body is fine seeded:

- `scope.byName` - field names to draw from the fixture (e.g. `['bio',
  'description', 'notes']`).
- `scope.bySchema` - named schemas to draw from the fixture wholesale (e.g.
  `['Address']`).

Everything outside the scope stays seeded and fast; only the named parts come
from the store.

`llm.persona` is a short domain hint included in every prompt - the kind of
detail that buys coherence no amount of seeded randomness produces on its own
(a B2B logistics domain, European customers, that sort of thing).

`llm.budget` caps a bake run: `maxCalls` limits how many requests are
attempted at all, and `timeoutMs` bounds how long a single call is allowed to
take before it counts as a miss. **`maxConcurrency` is a per-call batch size,
not a concurrency bound. Nothing in the bake pipeline runs concurrently.** The
driver awaits each chunk of requests before starting the next, and every
shipped source handles its chunk sequentially - the name is a holdover from
an earlier design, not a description of what happens today. A source can
override the chunk size with its own `chunkSize`, which is how a source with
a genuine batch threshold (see below) ever sees enough requests at once to
reach it.

## Anthropic as a hosted alternative

`llm.provider: 'anthropic'` swaps in Claude instead of a local or
self-hosted OpenAI-compatible endpoint. It uses `@anthropic-ai/sdk` as an
**optional peer dependency**, imported lazily only when that provider is
actually configured - installing it is not required for anything else in
this guide, or for the OpenAI-compatible path at all. Configure it with
`llm.anthropic.model`, `llm.anthropic.apiKey`, and (for large bake runs)
`llm.anthropic.batchThreshold`, which is where that provider's own batching
threshold lives rather than in the shared `budget`.
