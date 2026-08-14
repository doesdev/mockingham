# mockingham

An OpenAPI-driven HTTP mock server. Point it at a document and get back a
server that answers every declared operation with deterministic data shaped
by that document's own schemas — no hand-written stubs, no drift between what
the mock returns and what the document says it should return.

```sh
npm install mockingham
```

## Why not Prism, MSW, or WireMock

If you've reached for one of those already, the difference here is what is
guaranteed rather than what is merely possible. mockingham commits to four
things as contracts, not happy accidents:

- **Determinism.** The same request against the same seed produces
  byte-identical output, every time, in every process. Nothing in a
  generation path reaches for `Math.random()`, `Date.now()`, or unordered
  iteration — randomness comes from one seeded PRNG. See
  [Determinism, demonstrated](#determinism-demonstrated) below.
- **One schema interpretation.** The same traversal of your OpenAPI schemas
  that generates a response body also compiles the validator an incoming
  request is checked against. Generation and validation cannot quietly
  disagree with each other, because they are not two implementations —
  they're one, read two ways. (One documented exception: see
  [Known limitations](#known-limitations).)
- **Errors stay on-contract.** When an operation declares its own error
  schema — a `422` with a body shape — that's what mockingham emits for it.
  The built-in error envelope is a fallback for operations that declare
  nothing, not the default for every failure.
- **A control plane built for a machine, not just a human.** Failure
  injection, reseeding, webhook emission, and fixture baking are all methods
  and MCP tools first, with the CLI as one caller among several — the same
  surface an agent drives is the one a test drives.

## Requirements and install

Node >= 24.2.0. There is no build step, and that's deliberate: the package
you install is the TypeScript source, stripped of types by Node itself at
run time. There is no compiled `dist/` standing between what shipped and what
you're debugging — the stack trace you get points at the same line you'd set
a breakpoint on.

`zod` is the only runtime dependency. `@anthropic-ai/sdk` (for baking
fixtures against Claude) and `@modelcontextprotocol/sdk` (for the MCP
server) are optional peer dependencies, imported lazily only when the
feature that needs them is actually used — neither has to be installed for
the rest of mockingham to work.

## A 60-second quickstart

This assumes a JSON OpenAPI document (YAML isn't parsed — convert it, or
pass an already-parsed object to `createMock`). The example below runs
against `./openapi.json`; substitute your own document's path.

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

```console
status 200
{
  "data": [
    {
      "id": "eb87bbc4-c43a-43f2-9353-a4a78e19bae3",
      "amount": 15.23,
      "currency": "ember",
      "status": "failed",
      "description": "larch",
      "createdAt": "2024-08-18T07:02:43.000Z"
    }
  ],
  "nextCursor": "umber"
}
```

`mock.fetch` takes a standard `Request` and returns a standard `Response` —
no port required for a test to call it directly. Call `mock.listen()` when
you actually want one; see the CLI reference below for the zero-code path.

Notice `currency`: the document declares it `pattern: "^[A-Z]{3}$"`, and the
generated value doesn't honor that. That's real, not a typo — see
[Known limitations](#known-limitations).

## Determinism, demonstrated

Rather than take the determinism claim on faith, build two independent mocks
on the same seed and compare the bytes they produce for the same request:

```ts
const mockA = createMock(doc, { seed: 'determinism-demo' })
const mockB = createMock(doc, { seed: 'determinism-demo' })

const requestFor = () =>
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30', {
    headers: { authorization: 'Bearer test-token' }
  })

const bodyA = await (await mockA.fetch(requestFor())).text()
const bodyB = await (await mockB.fetch(requestFor())).text()

console.log(`same bytes: ${bodyA === bodyB}`)

await mockA.close()
await mockB.close()
```

```console
same bytes: true
```

That's two mocks in the same process. The stronger claim — the same seed
produces the same bytes across separate `node` processes, not merely two
objects in one — is what `scripts/determinism.ts` exists to check: run it,
run it again, and diff the two runs by hand. Nothing about generation reaches
outside the seeded PRNG in `generate/rng.ts` for anything that ends up in a
response body, which is what makes that comparison meaningful rather than
lucky.

## The tour

### Generation and determinism

Every value mockingham generates comes from `schema/walk.ts`'s traversal of
your schema, driven by the seeded PRNG — types, `format` (`uuid`,
`date-time`, `email`, and friends), and numeric/string constraints
(`minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `enum`) are
all honored. `pattern` is the one constraint that isn't; see
[Known limitations](#known-limitations).

### Overrides and headers

`operations` in `createMock`'s options lets you pin a status, layer a body
override on top of what generation would have produced, add response
headers, or replace an operation's response handling outright with a
`respond(ctx)` callback that gets `ctx.generate()`, `ctx.respond()`, and a
mutable `ctx.log` for structured logging (see [Logging](#logging) below).
Resolution for a response body is layered: an explicit override wins over a
served fixture, which wins over a declared OpenAPI example, which falls back
to seeded generation — nothing downstream needs to know which tier a body
actually came from.

### Validation and auth

Incoming requests are validated against the operation's declared parameter
and body schemas by default — the same compiled schema generation reads, per
the one-schema-interpretation guarantee above. A request that fails
validation gets a `400` on the operation's own error contract when it
declares one. `security` follows OpenAPI's own semantics: the array is OR —
satisfying any one requirement object is enough — and within a single
requirement object every named scheme is AND, all of them required. A
missing or malformed credential is a `401`; wire a `verify` callback per
scheme to check the credential's actual value and grant scopes, and an
unmet scope becomes a `403` rather than a bare rejection.

### Failure simulation

`mock.failNext(target, { times, status })` fails the next matching request(s)
outright; `mock.outage(target, { forMs, status })` fails every matching
request for a window of time. Both are also driven declaratively through a
`failure` policy list — a match pattern, a failure rate, injected latency
(applied even when the request succeeds), and an optional circuit breaker
that opens after a run of failures within an accumulation window, answers
every matching request with a fixed status while open, and closes again on
its own once its own open duration — a separate window from the one
failures accumulated in — expires. `target` is method-and-path or an
operation id, the same resolution the MCP write tools share.

### Idempotency

Declare an `Idempotency-Key` parameter on an operation (or opt a method in
via `idempotency.methods`) and a replayed request with the same key and the
same body returns the exact response that was recorded the first time,
byte-identical, no regeneration involved. A different body under the same
key is a conflict — `409` by default — because silently serving a different
response for the same idempotency key would defeat the point of declaring
one.

### Webhooks

Both OpenAPI shapes for an outbound call — a top-level `webhooks` entry and
an operation's `callbacks` — resolve through the same lookup, fire on an
explicit `mock.emit()` or an operation-linked trigger, and never affect the
response that triggered them: a throw while building an emission reaches
`onError`, never the caller. `captureOnly` makes the whole thing testable
in-process with no receiver and no network. See
[docs/webhooks.md](docs/webhooks.md).

### Fixtures and LLM content

A fixture is a reviewed, committed response body on disk. `mockingham bake`
walks every operation and writes what a content source returns; serving
falls through fixture → declared example → seeded generation whenever the
store misses, so an absent, slow, or refusing LLM never turns into a broken
mock. The default source talks to a local Ollama instance; Claude is
available as an optional hosted alternative. See
[docs/fixtures.md](docs/fixtures.md).

### MCP

`mock.mcp()` exposes read tools (list and describe operations, sample a live
response, inspect webhooks and deliveries) and, behind an explicit
`--write` flag, write tools that mutate the mock's runtime state (arm a
failure, reseed, emit a webhook, reset). `sample_response` runs through the
exact same `fetch()` every other caller uses, so it can't drift from what a
real client gets. See [docs/mcp.md](docs/mcp.md).

### Logging

`onLog` receives one structured record per request, after the response is
final — a sink throwing can never affect what the caller received. The
record distinguishes the *templated* route (`/payments/{id}`, bounded, safe
as a metrics tag) from the *resolved* path (unbounded, never a tag). See
[docs/logging-datadog.md](docs/logging-datadog.md).

## CLI reference

```sh
mockingham ./openapi.json --port 4000
```

Serves the document. `--seed <s>` pins generation, `--fixtures <dir>` serves
committed fixture files ahead of generation, `--watch` reloads the document
when it changes on disk, and with no `--port` an ephemeral one is chosen.

```sh
mockingham bake ./openapi.json --fixtures ./fixtures --model llama3.3
```

Generates fixture files offline: `--base-url` for an OpenAI-compatible
endpoint (default `http://localhost:11434/v1`, a local Ollama), `--model`
(required, or set `MOCKINGHAM_LLM_MODEL`/`OPENAI_MODEL`), `--api-key`, and
`--persona` for a short domain hint included in every prompt.

```sh
mockingham mcp ./openapi.json --write
```

Serves the MCP tools over stdio. `--seed` and `--fixtures` behave the same
as the plain server; `--write` exposes the five tools that mutate runtime
state (off by default, since read tools never do).

Every subcommand accepts `--help`/`-h`, and none of them parse YAML — convert
to JSON first, or call `createMock()` from a script with the document already
parsed.

## Known limitations

- **`pattern` is not honored by generation.** A field declared
  `"pattern": "^[A-Z]{3}$"` is validated against that pattern on the way in,
  but nothing constrains what gets generated on the way out — the
  quickstart's `"currency": "ember"` above is that exact gap, not a
  cherry-picked example. Pin the field with an override, a fixture, or a
  declared OpenAPI example if a caller needs to see a value that actually
  matches. No startup warning fires for a pattern outside what generation
  can produce, because generation makes no attempt at `pattern` at all.
- **Recursive schemas terminate at a configurable `maxDepth`** rather than
  generating forever, and are excluded from LLM-backed fixture generation
  entirely — structured-output APIs can't express a recursive JSON Schema.
- **No stateful CRUD.** A `POST` does not change what a later `GET` returns;
  every response is generated (or served from a fixture) independently.
  Idempotency replay is the one exception, and it replays a stored response
  rather than modeling state.
- **YAML documents are not parsed.** Convert to JSON first, or parse it
  yourself and pass the object to `createMock()`.
- **`oneOf`/`anyOf` selection is seeded, not exhaustive.** Which variant
  comes back is deterministic for a given seed but not chosen by you;
  `Prefer: example=<name>` or a body override pin a specific one.
  Runtime-expression callback URLs work the same way: an expression outside
  the supported subset (`$url`, `$method`, `$statusCode`, `$request.header`/
  `.query`/`.path`/`.body`, and `$response.header`/`.body`) is warned about
  at construction and never captures a destination from the request — it
  falls through to a configured static `url` for that webhook name if one
  exists, or to `unresolved` if not. The operation's own response is
  unaffected either way. See [docs/webhooks.md](docs/webhooks.md) for the
  full destination-resolution precedence.
- **Webhooks fire only on an explicit `emit()` or a triggering operation.**
  There are no recurring emitters and no chained deliveries — a delivery
  never triggers another webhook — and retry state lives in memory, so it
  does not survive a process restart.

## License and the design spec

MIT. The behavior above is the operating manual; the contract it's
implementing is
[docs/superpowers/specs/2026-08-11-mockingham-design.md](docs/superpowers/specs/2026-08-11-mockingham-design.md).
