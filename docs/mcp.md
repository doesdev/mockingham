# The MCP server

mockingham can expose itself to an MCP client - Claude, or anything else
speaking the protocol - as a set of tools an agent calls directly instead of
a human reading responses off a terminal. The important thing to understand
before any of the tool descriptions below: **every tool is a thin adapter
over a `Mock` method that already exists and is already tested elsewhere in
this project.** `fail_next` calls `mock.failNext`. `emit_webhook` calls
`mock.emit`. The MCP layer invents no new behavior of its own to get wrong -
it exposes behavior this project already had, which is also why
`sample_response`, covered below, turns out to be the least interesting tool
here rather than the most.

`@modelcontextprotocol/sdk` is an **optional peer dependency**, the same
shape `@anthropic-ai/sdk` has for baking (`docs/fixtures.md`). It is a
devDependency of this repo, so it resolves for every runnable example on this
page; a consumer of the published package only needs to install it if they
actually call `mcp()`. Without it, `mcp()` itself still returns a handle -
master §1 types it as synchronous, so a missing package cannot be reported
from inside the call - but the first thing that touches the SDK,
`connectStdio()` or the first HTTP request to the mount, throws an error naming
the package and the `npm install @modelcontextprotocol/sdk` command that fixes
it (`src/mcp/server.ts`).

The exact wording is deliberately not reproduced here as a fenced block. No
runnable example on this page provokes it, so the harness has no way to diff it
against what the code actually prints - and a block that looks like verified
output while being hand-copied is the failure mode worth avoiding more than the
convenience is worth having.

## stdio

The shape most MCP clients expect - a subprocess talking JSON-RPC over
stdin/stdout:

```sh
mockingham mcp ./openapi.json
```

Nothing is written to stdout while this runs: stdout **is** the JSON-RPC
channel, so a stray log line would corrupt every message after it. All of
this subcommand's own logging - "MCP server ready for ...", warnings - goes
to stderr instead. It is the one place this project's usual logging
convention bends, and it bends for a protocol requirement rather than a
preference.

Add `--seed <s>` to pin generation, `--fixtures <dir>` to serve a fixture
store the way the plain server does, and `--write` to open the write gate
(see "The write gate" below).

## http

`mcp()` mounts on the mock's **own** fetch surface rather than opening a
second port. That surface is `mock.fetch()` whether or not `listen()` has
ever been called, so the mount works before or after it - the dispatcher
reads a mutable mount slot on every request rather than deciding at
construction time:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'docs' })
const server = mock.mcp({ transport: 'http', path: '/mcp' })

console.log(`mounted at ${server.path}`)
await server.close()
```

```console
mounted at /mcp
```

`transport` defaults to `'inline'` - a server with no transport attached at
all, which is what a unit test wants and what the two tool-call examples
below build for themselves. `'stdio'` does not connect by itself: `mcp()`
only branches on `'http'` (`src/index.ts`), so a `'stdio'` handle still needs
an explicit `await handle.connectStdio()` before it talks JSON-RPC - which is
exactly what the `mockingham mcp` subcommand does on your behalf
(`src/server/cli.ts`). Only `'http'` writes anything into the mount slot.

## The twenty-two tools

Nine read tools, always available:

- `list_operations` - method, path, `operationId`, summary, and tags for
  every operation; filter with `tag` or `pathPrefix`.
- `describe_operation` - the full contract for one operation: parameters,
  request body schema, every declared response schema, security
  requirements, declared examples.
- `search_operations` - free-text search over path, summary, description,
  and tags, ranked by where the match landed.
- `sample_response` - a live response from the real request pipeline. See
  the third item below.
- `get_auth_requirements` - the document's security schemes, plus one
  operation's own requirements when `operationId` is given.
- `list_webhooks` - declared webhooks and callbacks, with payload schemas
  and which operations are configured to emit them.
- `list_deliveries` - webhook deliveries recorded so far, oldest first,
  filterable by webhook name and outcome.
- `list_registrations` - the webhook destinations registered right now, URLs
  included, filterable by webhook name.
- `list_fixtures` - what is in the fixture store: which operations and
  statuses have a stored response, when it was generated, and whether it has
  gone `stale` because the document changed underneath it. Values are omitted
  unless you pass `includeValues`.

Thirteen write tools, gated behind `--write` (see below):

- `fail_next` - make the next request(s) to a target fail.
- `outage` - fail every request to a target for a window of time.
- `emit_webhook` - fire a declared webhook now, optionally at a chosen URL.
- `set_seed` - reshuffle every generated value, deterministically.
- `reset` - restore the configured baseline: armed failures, idempotency
  keys, counters, captured deliveries. Also clears runtime overrides.
- `set_override` - pin what an operation returns at runtime, without editing
  config. Layers over any configured override the same way `mock.override()`
  does. Target is a control-plane string: `"POST /orders"`, an operationId,
  or `"* /**"` for every operation.
- `clear_overrides` - remove runtime overrides set by `set_override`. With no
  target, clears every operation. Never touches the overrides in your config
  file.
- `set_variant` - pin which branch of a union an operation generates. A
  `Prefer: variant=` header on a request outranks it; a name matching no
  branch falls through to the seeded pick.
- `clear_variants` - remove variant preferences set by `set_variant`. With no
  target, clears every operation.
- `redeliver_webhook` - send a recorded delivery again byte for byte, under
  the same delivery id. An unknown or aged-out id is an error; a delivery that
  fails is a returned outcome, not an error.
- `register_webhook_destination` - point a declared webhook at a URL, as a
  subscription operation would. Optionally scoped.
- `unregister_webhook_destination` - remove one scope's registration.
- `regenerate_fixture` - re-run the configured content source for one
  operation, replacing its stored fixtures. Requires an llm source. Identify
  the operation by `operationId`, or by `method` and `path`; add `status` to
  regenerate just one. Returns the bake summary, so an operation with no JSON
  body reads as `skipped` rather than as success.

`describe_operation`, `sample_response`, and `get_auth_requirements` all
identify an operation by `operationId`, or by `method` and `path` together.
**Every field you supply is checked**, so passing an `operationId` alongside a
`method`/`path` pair that names a different operation raises rather than
quietly answering about one of them. Supply one form or the other, or make them
agree.

`regenerate_fixture` behaves the same way, and additionally raises when the
operation or status does not exist rather than reporting a summary of zeroes -
an agent handed `{"generated": 0}` for a typo has been told it succeeded at
doing nothing.

**An operation the document never named still has an id.** The fixture store
keys on a synthesized slug - `GET /reports/daily` becomes `get_reports_daily` -
so that is the `operationId` `list_fixtures` reports for it and the one
`regenerate_fixture` takes. Every tool above accepts that slug too, falling
back to it when no operation declares the id outright, so an `operationId` read
from any tool can be passed to any other. A declared `operationId` always wins
over another operation's synthesized slug.

**`regenerate_fixture` can write to disk.** With a disk-backed fixture store
(`--fixtures <dir>`, or `createDiskFixtureStore`), storing a fixture writes it
to that directory, exactly as `bake()` does. The `--write` gate is what stands
between an agent and that directory.

## The ready-to-paste client config

```json
{
  "mcpServers": {
    "mockingham": {
      "command": "npx",
      "args": ["mockingham", "mcp", "./openapi.json", "--write"]
    }
  }
}
```

## Three things you'd otherwise learn the hard way

The rest of this guide runs one demonstration mount and drives it with real
JSON-RPC frames, the same way `mock.fetch()` is driven anywhere else in this
project - no client library involved, because the mount is just another
route on the mock:

```ts
function rpc(body: unknown): Request {
  return new Request('http://mock.local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify(body)
  })
}

const demoMock = createMock(doc, { seed: 'docs' })
const demo = demoMock.mcp({ transport: 'http', path: '/mcp' })
```

**First: `--write` gates all thirteen write tools because they change the
mock's state.** Every one of them mutates something a second caller would
observe - an armed failure, a reseeded generator, a cleared store, a runtime
override, a pinned union variant, a registered webhook destination, a second
copy of a delivery in the log, a replaced fixture. Read tools never do, so only
the thirteen are behind the flag, and the flag is off by default.
`regenerate_fixture` is the one that can reach past runtime state to disk,
which is part of what the gate is protecting.

**Second: closing the gate does not hide the tools - it disables them, and
says so.** An agent that already knows a write tool's name still sees it in
`tools/list`; hiding the name and naming the flag that would enable it
cannot both happen, and the flag is the more useful half of that choice
(the MCP design delta §3.7):

```ts
const listResponse = await demoMock.fetch(
  rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
)
const listPayload = await listResponse.json() as {
  result: { tools: Array<{ name: string; description: string }> }
}
const failNextEntry = listPayload.result.tools.find((tool) => tool.name === 'fail_next')
console.log(`fail_next still listed: ${failNextEntry !== undefined}`)
console.log(`${failNextEntry?.description ?? ''}`)
```

```console
fail_next still listed: true
Disabled. fail_next changes the mock's runtime state, so it is off by default. Enable the write tools with mcp({ write: true }) or the --write flag.
```

Calling it anyway - `tools/call` on the disabled name - refuses, and the
refusal names the same flag rather than reading like the tool never existed:

```ts
const callResponse = await demoMock.fetch(rpc({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'fail_next', arguments: { target: 'GET /payments' } }
}))
const callPayload = await callResponse.json() as {
  result?: { content: Array<{ text: string }> }
}
console.log(`${callPayload.result?.content[0]?.text ?? ''}`)
```

```console
mockingham: fail_next is a write tool and write tools are disabled. Enable them with mcp({ write: true }) or --write.
```

**Third: `sample_response` *is* `mock.fetch()`, so it 401s on a
credential-protected operation exactly like a real client would.** The
no-drift guarantee master §17 originally framed as a test obligation is
structural instead (the MCP design delta §3.3): the tool builds a `Request` and hands it to
the same `fetch()` every other caller uses, rather than running a second
generation path that could quietly disagree with the first. `getPayment`
requires `bearerAuth`, and the call below supplies no credentials:

```ts
const sampleResponse = await demoMock.fetch(rpc({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'sample_response',
    arguments: { operationId: 'getPayment', params: { id: 'demo-id' } }
  }
}))
const samplePayload = await sampleResponse.json() as {
  result: { content: Array<{ text: string }> }
}
const sample = JSON.parse(samplePayload.result.content[0]!.text) as { status: number }
console.log(`sample_response without credentials: ${sample.status}`)
```

```console
sample_response without credentials: 401
```

An auth shortcut inside the tool would have re-created exactly the second
code path the no-drift design exists to prevent - `sample_response` would
then no longer show you what your real client is going to get.

## `list_webhooks` merges callbacks, and one of its fields needs care

`api.webhooks` - what `list_webhooks` reads from - is not only the
document's top-level `webhooks` object. `loadApi` folds every operation's
`callbacks` into the same map under their own names (`src/spec/load.ts`,
lines 147–161, and see `docs/webhooks.md`), so against `docs/example.json`
`list_webhooks` reports both `paymentFailed` (a top-level webhook) and
`paymentSucceeded` (`createPayment`'s callback) - not only the top-level one:

```ts
const webhooksResponse = await demoMock.fetch(rpc({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'list_webhooks', arguments: {} }
}))
const webhooksPayload = await webhooksResponse.json() as {
  result: { content: Array<{ text: string }> }
}
const webhooks = JSON.parse(webhooksPayload.result.content[0]!.text) as
  Array<{ name: string; kind: string; emittedBy: string[]; expression?: string }>
console.log(JSON.stringify(
  webhooks.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    emittedBy: entry.emittedBy,
    expression: entry.expression
  })),
  null,
  2
))

await demo.close()
await demoMock.close()
```

```console
[
  {
    "name": "paymentFailed",
    "kind": "webhook",
    "emittedBy": []
  },
  {
    "name": "paymentSucceeded",
    "kind": "callback",
    "emittedBy": [
      "POST /payments"
    ],
    "expression": "{$request.body#/callbackUrl}"
  }
]
```

`paymentSucceeded`'s `emittedBy` names `POST /payments` because that is where
the callback is declared (the MCP design delta §3.6). **`emittedBy` is the union of the
declaring operation and every configured emitter**, deduplicated, with the
declaring operation first. Configuring some other operation's `emits` to fire a
callback's webhook adds that operation to the list rather than replacing the
one that declares it - which it did until the ledger-clearing cycle, quietly
dropping the declaring operation the moment any config named the webhook.

`payloadSchema` routes through the same fallback every other schema on this
server does: `{ "$comment": "not expressible as JSON Schema; this operation is
generated only" }` when the converter cannot turn a schema into JSON Schema.
In practice that placeholder is hard to provoke - **recursion is not such a
case**, contrary to what an earlier revision of this guide said. A recursive
payload is expressed with `$defs` and `$ref` and comes back in full.

## Telling a round-tripping operation from a generating one

An operation that replays something the mock recorded and one that generates a
fresh response every time look identical from outside - and that difference is
the difference between an operation a workflow can be built against and one
that will quietly not round-trip. `describe_operation` answers it directly:
alongside the contract, every operation reports `linksFrom` and `linksTo` (the
response-link rule indices it records for and recalls from), `registersWebhook`
and `unregistersWebhook`, and `idempotencyKey` - a `{ source, value }` pair
naming a header or a body pointer rather than a bare string, because those are
not the same kind of thing and a caller that has to guess will guess wrong.

The fields are defaulted rather than left absent: a document with no linking at
all still answers with `[]` instead of silence, so an agent can read the answer
without distinguishing "no" from "this server is too old to say".

```ts
const capabilityMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  link: [{
    from: { target: 'createPayment', key: '{$response.body#/id}' },
    to: { target: 'getPayment', key: '{$request.path.id}' }
  }],
  webhooks: {
    paymentFailed: {
      registerVia: { operationId: 'createPayment', url: '{$request.body#/callbackUrl}' }
    }
  }
})
const capabilityMount = capabilityMock.mcp({ transport: 'http', path: '/mcp' })

const describeResponse = await capabilityMock.fetch(rpc({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'describe_operation', arguments: { operationId: 'createPayment' } }
}))
const describePayload = await describeResponse.json() as {
  result: { content: Array<{ text: string }> }
}
const described = JSON.parse(describePayload.result.content[0]!.text) as {
  linksFrom: number[]
  linksTo: number[]
  registersWebhook: string[]
  unregistersWebhook: string[]
  idempotencyKey?: { source: string; value: string }
}
console.log(JSON.stringify({
  linksFrom: described.linksFrom,
  linksTo: described.linksTo,
  registersWebhook: described.registersWebhook,
  unregistersWebhook: described.unregistersWebhook,
  idempotencyKey: described.idempotencyKey
}, null, 2))
```

```console
{
  "linksFrom": [
    0
  ],
  "linksTo": [],
  "registersWebhook": [
    "paymentFailed"
  ],
  "unregistersWebhook": [],
  "idempotencyKey": {
    "source": "header",
    "value": "Idempotency-Key"
  }
}
```

`createPayment` records for link rule `0`, registers `paymentFailed`, and keys
idempotency off the `Idempotency-Key` header the example document declares on
it. `getPayment` would report the mirror image - `linksTo: [0]`, nothing else.

`list_webhooks` answers the same question from the webhook's side, with a
`registry` field saying whether a registry is configured and how many
registrations exist right now. It deliberately does **not** return the URLs: a
registered destination is a consumer's endpoint, and a capability listing is
something an agent may dump into a log. `list_registrations` returns them,
because asking for them is a different act from being told:

```ts
await capabilityMock.register('paymentFailed', 'https://consumer.test/hooks', 'acme')

const registrationsResponse = await capabilityMock.fetch(rpc({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'list_registrations', arguments: { webhook: 'paymentFailed' } }
}))
const registrationsPayload = await registrationsResponse.json() as {
  result: { content: Array<{ text: string }> }
}
console.log(`${registrationsPayload.result.content[0]?.text ?? ''}`)

await capabilityMount.close()
await capabilityMock.close()
```

```console
[
  {
    "webhook": "paymentFailed",
    "url": "https://consumer.test/hooks",
    "scope": "acme"
  }
]
```

The listing is sorted by webhook then scope, and that ordering is the registry's
own contract rather than something re-imposed here - one ordering decided in one
place, so this tool and `mock.registrations()` cannot disagree.

## The write tools that arrived with the registry

Five of the twelve write tools arrived with the registry, and each is worth a
sentence beyond its bullet, because each has a failure mode that is a deliberate
choice rather than an accident:

- **`set_variant`** stores a per-operation union-branch preference. A
  `Prefer: variant=` header on a request outranks it, and a name matching no
  branch falls through to the seeded pick rather than erroring - the name
  arrives from a caller, so there is nothing to validate it against, and a
  runtime warning would fire constantly for the many responses containing no
  union at all.
- **`clear_variants`** drops those preferences, for one operation or for all of
  them. Like `clear_overrides`, `clear_variants` with no target echoes `null`
  rather than `'*'`, because a bare `'*'` is not a valid target and echoing it
  would teach a caller a string that throws on its next call.
- **`redeliver_webhook`** takes a delivery id alone - the webhook name is
  recoverable from the record, and a two-argument form that could disagree with
  itself is a defect surface for no benefit. An unknown id, or one aged out of
  the 1000-entry log, is an **error**; a redelivery that is attempted and fails
  is a returned outcome, not an error. Those two cases are different questions
  and get different answers.
- **`register_webhook_destination`** and
  **`unregister_webhook_destination`** write the same registry a document's
  `registerVia` operation writes, with the same scoping. An emission addressing
  a scope with nothing registered is `outcome: 'unresolved'` - a recorded
  delivery with no URL, not a thrown error and not a silent drop.

## Every declared tool now ships

Master §15 and the refinements and regenerate deltas name twenty-two tools
between them, and this server exposes all twenty-two. Earlier revisions of this
guide carried a "what isn't here yet" section; there is nothing left to put in
it.

That section also described `regenerate_fixture` as "a tool to save a
live-generated response as a committed fixture", which was never what the
specification said and is not what shipped. It re-runs the configured content
source - the LLM - for one operation. Saving whatever the mock generated a
moment ago, with no source involved, is a different and genuinely useful tool
that does not exist.
