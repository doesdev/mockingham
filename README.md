# mockingham

[![CI](https://github.com/doesdev/mockingham/actions/workflows/ci.yml/badge.svg)](https://github.com/doesdev/mockingham/actions/workflows/ci.yml)

An OpenAPI-driven HTTP mock server. Point it at a document and get back a
server that answers every declared operation with deterministic data shaped
by that document's own schemas - no hand-written stubs, no drift between what
the mock returns and what the document says it should return.

```sh
npm install mockingham
```

## Why not Prism, MSW, or WireMock

If you've reached for one of those already, the difference here is what is
guaranteed rather than what is merely possible. mockingham commits to four
things as contracts, not happy accidents:

- **Determinism.** The same sequence of requests against the same seed
  produces byte-identical output, every time, in every process. Nothing in a
  generation path reaches for `Math.random()`, `Date.now()`, or unordered
  iteration - randomness comes from one seeded PRNG. Sequence rather than a
  lone request because a handful of features deliberately make a response
  depend on what came before it; see
  [Determinism, demonstrated](#determinism-demonstrated) below and the note
  under [Response linking](#response-linking).
- **One schema interpretation.** The same traversal of your OpenAPI schemas
  that generates a response body also compiles the validator an incoming
  request is checked against. Generation and validation cannot quietly
  disagree with each other, because they are not two implementations -
  they're one, read two ways. (One documented exception: see
  [Known limitations](#known-limitations).)
- **Errors stay on-contract.** When an operation declares its own error
  schema - a `422` with a body shape - that's what mockingham emits for it.
  The built-in error envelope is a fallback for operations that declare
  nothing, not the default for every failure.
- **A control plane built for a machine, not just a human.** Failure
  injection, reseeding, webhook emission, runtime overrides, and fixture
  baking are all methods and MCP tools first, with the CLI as one caller
  among several - the same surface an agent drives is the one a test drives.

## Requirements and install

Node >= 24.2.0. The package installs as compiled JavaScript with type
declarations, and the TypeScript source ships alongside it purely so the
declaration and source maps resolve: your debugger still lands on the same
line of `.ts` you'd set a breakpoint on, while Node loads `.js`.

Through 0.2.0 the package shipped source as its entry points, on the
reasoning that Node strips types itself. It does - except under
`node_modules`, where stripping is refused by a documented restriction that
no flag turns off. Every install of 0.2.0 therefore failed on
`import 'mockingham'` and on the `mockingham` bin alike. 0.2.1 compiles.
`npm run check:install` packs, installs into an empty directory, imports by
name and runs the bin; CI runs it, because no test inside this repository can
see that class of defect.

`zod` is the only runtime dependency. `@anthropic-ai/sdk` (for baking
fixtures against Claude) and `@modelcontextprotocol/sdk` (for the MCP
server) are optional peer dependencies, imported lazily only when the
feature that needs them is actually used - neither has to be installed for
the rest of mockingham to work.

## A 60-second quickstart

This assumes a JSON OpenAPI document (YAML isn't parsed - convert it, or
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
      "currency": "UMQ",
      "status": "failed",
      "description": "pine-cedar",
      "createdAt": "2024-01-07T13:07:53.197Z"
    }
  ],
  "nextCursor": "basalt"
}
```

`mock.fetch` takes a standard `Request` and returns a standard `Response` -
no port required for a test to call it directly. Call `mock.listen()` when
you actually want one; see the CLI reference below for the zero-code path.

Notice `currency`: the document declares it `pattern: "^[A-Z]{3}$"`, and
`"UMQ"` is generated from that pattern rather than in spite of it. Generation
covers a documented subset of regex - see
[Known limitations](#known-limitations) for what falls outside it.

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

That's two mocks in the same process, which a fixed seed makes easy. The
stronger claim - the same seed produces the same bytes across separate `node`
processes, not merely two objects in one - is asserted by
`test/determinism/cross-process.test.ts`, which spawns `scripts/determinism.ts`
twice as real subprocesses and diffs their output. It runs on every `npm test`;
there is nothing to check by hand. Nothing about generation reaches outside the
seeded PRNG in `generate/rng.ts`, or the seeded clock in `generate/clock.ts`
for UUIDv7 timestamps, which is what makes that comparison meaningful rather
than lucky.

## The tour

### Generation and determinism

Every value mockingham generates comes from `schema/walk.ts`'s traversal of
your schema, driven by the seeded PRNG - types, `format` (`uuid`,
`date-time`, `email`, and friends), and numeric/string constraints
(`minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `enum`) are
all honored. So are `uniqueItems`, which draws array members without
replacement, and `if`/`then`/`else`, which picks a branch and generates a body
that actually satisfies it. `pattern` is honored for a documented subset of
regex, and
outranks both a conflicting `format` and a conflicting length bound; see
[Known limitations](#known-limitations) for the constructs outside that subset.

**Time-ordered ids.** `format: "uuid7"` (and the spellings `uuidv7` and
`uuid-v7`) generates RFC 9562 version 7 UUIDs, which sort by creation time -
the property people reach for the moment they adopt v7. A real clock in a
generation path would violate determinism outright, so the timestamp comes from
a **seeded virtual clock** starting at `seedTime`. Each request, and each
webhook emission, reserves its own block of timestamps at the moment it
arrives or is scheduled; values within a block advance one millisecond apiece.
Monotonic within a run, identical across runs on the same seed.

Reserving up front rather than drawing per value is what makes ids ordered by
*request* order instead of by whichever generation happened to finish first -
generation runs after overrides, variants and fixtures have all resolved, and a
webhook with `afterMs` generates on a timer. So a caller who waits between two
calls gets the same bytes as one who doesn't. The block size caps how many v7s
one request can mint before it stops sorting strictly ahead of the next
request's; it is 65,536, which no mock will reach.

`seedTime` defaults to a fixed epoch constant (`2025-01-01T00:00:00Z`), never
`Date.now()` - a wall-clock default would make baked fixtures unstable across
runs, which is the exact failure `seedTime` exists to prevent. It must be a
whole number of milliseconds from 0 up to 2^48, and anything else throws at
construction rather than generating a malformed id. `reset()` returns the
clock to `seedTime`.

If a document can't change `format` without breaking another consumer's
validation, put `x-mock-format: "uuid7"` beside a plain `format: "uuid"`
instead; `x-mock-format` wins when both are present.

```ts
const eventsDoc = {
  openapi: '3.1.0',
  info: { title: 'Events', version: '1.0.0' },
  paths: {
    '/events': {
      post: {
        operationId: 'createEvent',
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string', format: 'uuid7' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

const idMock = createMock(eventsDoc, { seed: 'readme', seedTime: 1735689600000 })
const mintedIds: string[] = []
for (let i = 0; i < 3; i++) {
  const created = await idMock.fetch(new Request('http://mock/events', { method: 'POST' }))
  mintedIds.push(((await created.json()) as { id: string }).id)
}

console.log(JSON.stringify(mintedIds, null, 2))
console.log(`lexical order is generation order: ${JSON.stringify(mintedIds) === JSON.stringify([...mintedIds].sort())}`)

await idMock.close()
```

```console
[
  "01941f29-7c00-7d48-b6ae-2228a20479a5",
  "01941f2a-7c00-7d48-b6ae-2228a20479a5",
  "01941f2b-7c00-7d48-b6ae-2228a20479a5"
]
lexical order is generation order: true
```

### Union variants

Which branch of a `oneOf`/`anyOf` comes back is a seeded pick by default. Send
`Prefer: variant=<name>` to ask for a specific one: a branch matches when its
formal `discriminator` property, or - with no `discriminator` object at all -
any of its const-valued properties, equals the name you asked for. That second
rule is what makes the common `outcome: { const: "conflict" }` shape work
without a discriminator declaration.

`mock.setVariant(target, name)` stores the same preference per operation for
callers who can't set a header, and `mock.clearVariants(target?)` removes it.
A `Prefer: variant=` header on a request outranks a stored preference, for the
same reason `Prefer: status` outranks a configured status: a header is a
statement about *this* call.

```ts
const checkoutDoc = {
  openapi: '3.1.0',
  info: { title: 'Checkout', version: '1.0.0' },
  paths: {
    '/checkout': {
      post: {
        operationId: 'checkout',
        responses: {
          '200': {
            description: 'The outcome',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['outcome', 'receiptId'],
                      properties: {
                        outcome: { const: 'settled' },
                        receiptId: { type: 'string' }
                      }
                    },
                    {
                      type: 'object',
                      required: ['outcome', 'reason'],
                      properties: {
                        outcome: { const: 'conflict' },
                        reason: { type: 'string' }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      }
    }
  }
}

const variantMock = createMock(checkoutDoc, { seed: 'readme' })

const preferred = await variantMock.fetch(
  new Request('http://mock/checkout', { method: 'POST', headers: { prefer: 'variant=conflict' } })
)
console.log(JSON.stringify(await preferred.json(), null, 2))

await variantMock.setVariant('checkout', 'settled')
const stored = await variantMock.fetch(new Request('http://mock/checkout', { method: 'POST' }))
console.log(JSON.stringify(await stored.json(), null, 2))

const headerWins = await variantMock.fetch(
  new Request('http://mock/checkout', { method: 'POST', headers: { prefer: 'variant=conflict' } })
)
console.log(`header outranks the stored preference: ${((await headerWins.json()) as { outcome: string }).outcome}`)

await variantMock.close()
```

```console
{
  "outcome": "conflict",
  "reason": "alder"
}
{
  "outcome": "settled",
  "receiptId": "alder"
}
header outranks the stored preference: conflict
```

A name matching no branch is **not** an error - it falls through to the seeded
pick, the same way an undeclared `Prefer: status` does. That is deliberate: the
name arrives in a header, so construction has nothing to validate it against,
and warning at runtime would fire constantly for the many responses that
contain no union at all.

The directive applies at every union in the tree; there is no per-union
targeting syntax. It does not reach webhook payloads or error envelopes - see
[Known limitations](#known-limitations).

### Response linking

A create-then-read loop is the one shape a purely generative mock can't fake:
you `POST /payments`, get an id back, `GET /payments/{that id}` - and get an
unrelated payment. `link` closes exactly that gap and nothing wider.

A rule names the operation that **records** (with an expression extracting the
key from its response), the operation that **recalls** (with an expression
extracting the key from its request), and optionally what to remember -
`remember` defaults to the whole response body. Both targets are control-plane
targets, resolved at construction, so a typo throws rather than silently never
linking.

```ts
const linkMock = createMock(doc, {
  seed: 'readme',
  link: [{
    from: { target: 'createPayment', key: '{$response.body#/id}' },
    to: { target: 'getPayment', key: '{$request.path.id}' }
  }]
})

const createdResponse = await linkMock.fetch(
  new Request('http://mock/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ amount: 12.5, currency: 'USD' })
  })
)
const createdPayment = await createdResponse.json() as { id: string }

const readBack = await linkMock.fetch(
  new Request(`http://mock/payments/${createdPayment.id}`, {
    headers: { authorization: 'Bearer test-token' }
  })
)
console.log(`the id round-trips: ${JSON.stringify(await readBack.json()) === JSON.stringify(createdPayment)}`)

const strangerResponse = await linkMock.fetch(
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30', {
    headers: { authorization: 'Bearer test-token' }
  })
)
const stranger = await strangerResponse.json() as { id: string }
console.log(`an id the mock never minted still generates: ${stranger.id !== createdPayment.id}`)

await linkMock.close()
```

```console
the id round-trips: true
an id the mock never minted still generates: true
```

**This is not stateful CRUD, and it is not becoming stateful CRUD.** Stateful
persistence is a stated non-goal of the design spec, and this feature does not
quietly reintroduce it. The claim is deliberately narrow: *an identifier the
mock itself minted resolves to the thing it minted it for.* A read whose key
matches replays recorded bytes; a read whose key doesn't generates normally.
That is the whole feature.

What the mock supplies no semantics of its own for is mutation and lifecycle.
It never infers that a `PUT` updates an entity, that a `DELETE` removes one, or
that a create should cascade into a collection - it has no model of your
resources to reason about. But **a rule you write is what decides which
operations record**, and nothing restricts `from` to creates. Add a second rule
whose `from` is your `PUT /payments/{id}` and whose `to` is the same `GET`, and
that `GET` can replay what the `PUT` returned. Point a rule's `to` at
`GET /payments` and that list replays what was recorded for its key. Those
behaviors come from the rules in your config, not from the mock inventing a
lifecycle; the example above has none of them because it declares one
create-to-read rule and nothing else.

Rules do **not** overwrite one another: each records under its own rule index,
so a `PUT` rule's entry and a create rule's entry coexist. What decides which
one a read sees is order - the recall loop stops at the first rule whose key
expression resolves to a recorded entry, so **declaration order in `link` decides
which rule wins**. Declare the `PUT` rule before the create rule and reads
follow the `PUT`; declare it after and reads keep returning what the create
minted, however many `PUT`s land in between. Put the rule you want to win first.

One trap worth naming: on a `PUT` rule, `from.key: '{$response.body#/id}'`
records under the id in the *generated response body*, not the id in the path.
Use `'{$request.path.id}'` there, or the rule records under a key no read will
ever ask for and silently does nothing.

A recalled body behaves exactly like a fixture layer, sitting beneath the
override layers and above generation:

```txt
runtime override > config override > link recall > fixture > example > generated
```

Only a success status recalls - replaying a recorded body into a `404` or a
`500` would be actively wrong, and failure injection exists precisely so a
caller can force those.

The recall table is bounded: `ttlMs` defaults to one hour and `max` to 1000
entries, oldest evicted first. A recall table is unbounded by construction -
every write mints a new key - so a long-lived mock without both bounds leaks
until the process dies.

Linking does make a `GET`'s response depend on whether a `POST` ran before it,
which is worth stating against the determinism guarantee above. The honest form
of that guarantee is **sequence** determinism: the same sequence of requests
against a fresh process with the same seed produces byte-identical output at
every step. That was always the real shape of it - request ordinals, the
webhook emission counter, idempotency replay, and armed `failNext` failures
each already make a response depend on what came before it. Linking adds
another such dependency; it does not introduce the category.

### Overrides and headers

`operations` in `createMock`'s options lets you pin a status, layer a body
override on top of what generation would have produced, add response
headers, or replace an operation's response handling outright with a
`respond(ctx)` callback that gets `ctx.generate()`, `ctx.respond()`, and a
mutable `ctx.log` for structured logging (see [Logging](#logging) below).

`mock.override(target, value)` sets the same shape of override at runtime,
after construction, with no config edit and no restart - `target` is the
same method-and-path-or-operation-id resolution the failure tools use, and
`"* /**"` matches every operation. `mock.clearOverrides(target?)` removes
what `override()` set; called with no target it clears every operation. Both
are exposed as MCP write tools (`set_override`, `clear_overrides`) - see
[docs/mcp.md](docs/mcp.md). A runtime override does not layer against
another runtime override: setting the same target twice replaces the value,
and two different targets that resolve to the same operation collide there,
with the later write winning. Setting a `status` the document doesn't
declare falls through to normal status selection rather than erroring. An
object-shaped body override applied to an operation whose response is an
array is a silent no-op - the array comes back byte-identical, with
`x-mock-override: applied` stamped anyway, since a body layer did exist even
though nothing in it matched. Use `{ '*': { ... } }` to reach every element,
or supply a literal JSON array instead.

Resolution for a response body is layered: a runtime override wins over a
config override, which wins over a served fixture, which wins over a
declared OpenAPI example, which falls back to seeded generation - nothing
downstream needs to know which tier a body actually came from.

### Validation and auth

Incoming requests are validated against the operation's declared parameter
and body schemas by default - the same compiled schema generation reads, per
the one-schema-interpretation guarantee above. A request that fails
validation gets a `400` on the operation's own error contract when it
declares one. `security` follows OpenAPI's own semantics: the array is OR -
satisfying any one requirement object is enough - and within a single
requirement object every named scheme is AND, all of them required. A
missing or malformed credential is a `401`; wire a `verify` callback per
scheme to check the credential's actual value and grant scopes, and an
unmet scope becomes a `403` rather than a bare rejection.

### Failure simulation

`mock.failNext(target, { times, status })` fails the next matching request(s)
outright; `mock.outage(target, { forMs, status })` fails every matching
request for a window of time. Both are also driven declaratively through a
`failure` policy list - a match pattern, a failure rate, injected latency
(applied even when the request succeeds), and an optional circuit breaker
that opens after a run of failures within an accumulation window, answers
every matching request with a fixed status while open, and closes again on
its own once its own open duration - a separate window from the one
failures accumulated in - expires. `target` is method-and-path or an
operation id, the same resolution the MCP write tools share.

### Idempotency

Declare an `Idempotency-Key` parameter on an operation (or opt a method in via
`idempotency.methods`, or point `idempotency.operations` at a body pointer such
as `'{$request.body#/meta/requestId}'` for documents that carry the key in the
payload rather than a header) and a replayed request with the same key and the
same body returns the exact response that was recorded the first time,
byte-identical, no regeneration involved. A different body under the same
key is a conflict - `409` by default - because silently serving a different
response for the same idempotency key would defeat the point of declaring
one.

### Webhooks

Both OpenAPI shapes for an outbound call - a top-level `webhooks` entry and
an operation's `callbacks` - resolve through the same lookup, fire on an
explicit `mock.emit()` or an operation-linked trigger, and never affect the
response that triggered them: a throw while building an emission reaches
`onError`, never the caller. `captureOnly` makes the whole thing testable
in-process with no receiver and no network. A **destination registry** covers
the subscribe-once shape - one operation registers a URL (optionally scoped per
tenant), every later emission goes there - and every delivery carries a
deterministic `id` that `mock.redeliver(id)` re-sends byte for byte. See
[docs/webhooks.md](docs/webhooks.md).

### The import surface

Everything public comes from the package root - `createMock`, `loadApi`, the
fixture store and content-source factories, and every published type - as in
the quickstart above. `package.json` declares an `exports` map with that one
entry, so paths inside `src/` are not importable: they are implementation
detail, and an internal path that works today would otherwise become a
compatibility obligation tomorrow. If something you need is not exported from
the root, that is a gap worth reporting rather than routing around.

### Fixtures and LLM content

A fixture is a reviewed, committed response body on disk. `mockingham bake`
walks every operation and writes what a content source returns; serving
falls through fixture → declared example → seeded generation whenever the
store misses, so an absent, slow, or refusing LLM never turns into a broken
mock. The default source talks to a local Ollama instance; Claude is
available as an optional hosted alternative. `mock.bake({ only: { … } })`
narrows a run to one operation, so refreshing a single response after the
document moves does not re-run the whole document against a paid model, and
`mock.fixtures()` shows what is stored. See
[docs/fixtures.md](docs/fixtures.md).

### MCP

`mock.mcp()` exposes nine read tools (list and describe operations, sample a
live response, inspect webhooks, deliveries and registrations, see what is in
the fixture store) and, behind an explicit `--write` flag, thirteen write tools
that mutate the mock's state (arm a failure, reseed, emit a webhook, reset, set
or clear a runtime override, pin or clear a union variant, register or
unregister a webhook destination, redeliver a recorded delivery, regenerate a
fixture). `sample_response` runs through the exact same `fetch()` every other
caller uses, so it can't drift from what a real client gets.
`regenerate_fixture` is the one tool that can reach disk - with a fixture
directory configured it writes there, exactly as `bake()` does, which is part
of what the `--write` gate is protecting. See
[docs/mcp.md](docs/mcp.md).

### Logging

`onLog` receives one structured record per request, after the response is
final - a sink throwing can never affect what the caller received. The
record distinguishes the *templated* route (`/payments/{id}`, bounded, safe
as a metrics tag) from the *resolved* path (unbounded, never a tag). See
[docs/logging-datadog.md](docs/logging-datadog.md).

## CLI reference

```sh
mockingham ./openapi.json --port 4000
```

Serves the document. `--seed <s>` pins generation, `--fixtures <dir>` serves
committed fixture files ahead of generation, `--watch` reloads the document
when it changes on disk, `--max-depth <n>` sets the generation depth budget
(default 12), and with no `--port` an ephemeral one is chosen.

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
as the plain server; `--write` exposes the twelve tools that mutate runtime
state (off by default, since read tools never do).

Every subcommand accepts `--help`/`-h`, and none of them parse YAML - convert
to JSON first, or call `createMock()` from a script with the document already
parsed.

## Known limitations

- **One schema keyword is not read at all: `not`.** A document declaring it
  is served and validated as though it were absent - generated bodies may
  violate it, and an incoming request that violates it is accepted. Nothing
  warns. Every other keyword named in this README is read by both generation
  and validation, from the one traversal in `src/schema/walk.ts`.
- **`propertyNames` and `patternProperties` are honored, with two named
  sacrifices.** Both are read from the shared traversal, so validation enforces
  them exactly: a key whose name violates `propertyNames` is a 400, and a key
  matching a `patternProperties` regex must satisfy that entry's schema. A
  matching key is *not* "additional", so `additionalProperties: false` still
  admits it, and a key covered by both `properties` and a pattern must satisfy
  both. Generation invents one member per pattern that no declared property
  already covers, drawing the *name* from the same documented regex subset
  `pattern` uses - a pattern outside that subset warns and contributes no
  member rather than inventing a name validation would reject. The two
  sacrifices: a declared property whose name `propertyNames` forbids is
  omitted where it is optional but **emitted anyway where `required` demands
  it**, since the two keywords then contradict each other outright; and an
  untyped `propertyNames` subschema (`{ "pattern": ... }`, `{ "maxLength": 4 }`)
  is read as a string schema, because a property name always is one.
- **`dependentRequired` and `dependentSchemas` are honored one level deep.**
  Validation applies both exactly. Generation emits a dependent that is not
  declared under `properties` - taking its shape from a matching
  `patternProperties` entry, then from `additionalProperties`, then leaving it
  unconstrained - and lays a triggered `dependentSchemas` shape over the object
  it generated. Where a dependent cannot be emitted at all (`additionalProperties:
  false` with nothing declared for it), an **optional** trigger is dropped
  instead, which satisfies the dependency exactly; a `required` trigger is kept
  and the contradiction stands. `dependentSchemas` entries are applied in one
  pass in declaration order, so an entry triggered by a key an *earlier* entry
  added is not applied - the same one-level rule `if`/`then`/`else` follows.
- **`if`/`then`/`else` applies one level deep.** A conditional on a schema is
  honored - generation picks a branch with the seeded PRNG and produces a body
  that satisfies it, and a request violating the branch it lands in is a 400.
  A conditional nested directly inside a `then` or `else` subschema is not
  applied. A conditional on a nested *property* is, at any depth.
- **`contains` yields to the array's own bounds when they conflict.**
  Generation draws `minContains` members (default 1) from the `contains`
  schema intersected with `items` or the tuple position they land on, so the
  generated array satisfies the keyword alongside `items`, `prefixItems`,
  `minItems` and `uniqueItems`. Where the constraints cannot all hold the
  array's own bounds win: `maxItems` caps the length even when that leaves
  fewer matching members than `minContains`, a crossed `minContains` /
  `maxContains` pair resolves to `maxContains`, a closed tuple satisfies
  `contains` from a tuple position rather than growing, and a `uniqueItems`
  draw that collides falls back to the plain item schema (the colliding member
  is already present, so it already matches). A member drawn from `items` that
  happens to match `contains` can still push the count past `maxContains`;
  declaring `maxContains` pins the generated length to the minimum to keep
  that unlikely. Validation is exact either way - a count outside
  `minContains`..`maxContains` is a 400.
- **`uniqueItems` yields as many distinct members as the item schema has.**
  An array asking for three unique members from a two-member `enum` generates
  two rather than repeating one or failing to serve; `minItems` loses to
  `uniqueItems` where the two cannot both hold. Validation is exact either
  way - a repeated member is a 400.
- **`pattern` is honored for a documented subset only.** Generation covers
  literals, character classes, shorthand escapes (`\d`, `\w`, `\s` and their
  negations), anchors, alternation, groups, and quantifiers - the quickstart's
  `"currency": "UMQ"` above is generated from `"pattern": "^[A-Z]{3}$"`.
  Unbounded `*` and `+` are capped at three repeats. Lookaround,
  backreferences, named groups and unicode property escapes are not
  expressible: a field declaring one falls back to `example`, then `default`,
  then an ordinary placeholder, and a warning naming the pattern is emitted
  once the first time such a value is generated. Requests are still validated
  against the full pattern either way, so pin the field with an override or a
  fixture when a caller needs a conforming value the subset cannot produce.
- **A `pattern` wins over a conflicting `minLength`/`maxLength`.** Padding a
  value to reach a minimum, or slicing it to fit a maximum, would break the
  match, so length bounds are honored only through the pattern's own
  quantifiers.
- **A `pattern` also wins over a conflicting `format`,** including
  `uuid7`/`x-mock-format`. A field declaring both generates from the pattern,
  so a schema that wants an ordered v7 timestamp must express it as a `format`
  rather than as a regex.
- **Recursive schemas terminate at a configurable `maxDepth`** rather than
  generating forever, and are excluded from LLM-backed fixture generation
  entirely - structured-output APIs can't express a recursive JSON Schema.
  The budget counts nesting levels and defaults to 12 (`--max-depth <n>` on
  the CLI, `maxDepth` in `createMock`). Resolving a `oneOf`/`anyOf` costs
  nothing, so a document truncates in the same place whether its payload sits
  behind a union or is written inline. When the budget does run out, the
  container is truncated to `{}` or `[]` - which can leave a 200 response
  missing properties the document declares `required` - and a warning naming
  the schema path is emitted once per path, so truncation is never silent.
- **No stateful CRUD.** A `POST` does not change what a later `GET` returns;
  every response is generated (or served from a fixture) independently.
  Idempotency replay and [response linking](#response-linking) are the two
  exceptions, and both replay stored bytes rather than modeling state: the mock
  supplies no mutation or lifecycle semantics of its own and never infers them
  from a method. A link rule you write decides which operations record and which
  replay, and it may name a write operation - see
  [Response linking](#response-linking).
- **Registration enumeration is process-local.** The `Store` holds the
  authoritative registration values, so a shared Store shares them across
  processes; the index of *known keys* that `registrations()` enumerates does
  not cross a process boundary. Identical in kind to the delivery log's own
  limitation.
- **The link table is bounded** at 1000 entries and one hour. A sequence
  exceeding either bound recalls nothing for the evicted keys and falls through
  to ordinary generation - a silent behavior change from the caller's point of
  view, not an error. That entry bound is also **process-local**: the recorded
  values go through the `Store`, but the eviction index that enforces `max`
  lives in the process, so N processes sharing one `Store` can leave up to
  N × `max` entries per rule in it. Identical in kind to the registration and
  delivery-log limitations above and below; `ttlMs` is the bound that still
  holds across processes.
- **Redelivery cannot reach a delivery evicted from the 1000-entry log.**
  `mock.redeliver(id)` throws in that case, naming the bound, rather than
  succeeding with nothing to send.
- **Only the `uuid7` spellings are matched loosely; every other `format` is
  exact.** The v7 check trims and lower-cases before comparing, so
  `format: "UUID7"`, `" uuidv7"` and `"UUID-V7"` all generate a v7. Nothing
  else works that way - the rest of `format` matching is exact string
  comparison against the lower-case name, so `format: "UUID"` matches no format
  at all and generates a plain dictionary word rather than a UUID. Do not read
  the v7 leniency as a general rule that formats are normalized; write `format`
  in lower case.
- **`set_variant` and `Prefer: variant=` do not reach webhook payloads or
  error envelopes.** An emitted webhook has no request and therefore no header,
  and steering an error envelope's union from a request header is not a
  behavior to introduce silently. Union selection in both stays seeded.
- **A `remember` expression addressing a non-scalar via a pointer records
  nothing.** `remember: '{$response.body}'` and `'{$request.body}'` are
  special-cased and take the parsed value directly, but a pointer form such as
  `'{$response.body#/items}'` resolves through a scalar coercion, fails, and
  records nothing. Point `remember` at a scalar, or leave it at its default.
- **YAML documents are not parsed.** Convert to JSON first, or parse it
  yourself and pass the object to `createMock()`.
- **`oneOf`/`anyOf` selection is seeded, not exhaustive.** Which variant
  comes back is deterministic for a given seed but not chosen by you;
  `Prefer: example=<name>` or a body override pin a specific one.
  Runtime-expression callback URLs work the same way: an expression outside
  the supported subset (`$url`, `$method`, `$statusCode`, `$request.header`/
  `.query`/`.path`/`.body`, and `$response.header`/`.body`) is warned about
  at construction and never captures a destination from the request - it
  falls through to a configured static `url` for that webhook name if one
  exists, or to `unresolved` if not. The operation's own response is
  unaffected either way. See [docs/webhooks.md](docs/webhooks.md) for the
  full destination-resolution precedence.
- **Webhooks fire only on an explicit `emit()` or a triggering operation.**
  There are no recurring emitters and no chained deliveries - a delivery
  never triggers another webhook - and retry state lives in memory, so it
  does not survive a process restart.

## License and the design spec

MIT - see [LICENSE](LICENSE). The behavior above is the operating manual; the
contract it's implementing is
[docs/superpowers/specs/2026-08-11-mockingham-design.md](docs/superpowers/specs/2026-08-11-mockingham-design.md).
