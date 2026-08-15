# The MCP server

mockingham can expose itself to an MCP client — Claude, or anything else
speaking the protocol — as a set of tools an agent calls directly instead of
a human reading responses off a terminal. The important thing to understand
before any of the tool descriptions below: **every tool is a thin adapter
over a `Mock` method that already exists and is already tested elsewhere in
this project.** `fail_next` calls `mock.failNext`. `emit_webhook` calls
`mock.emit`. The MCP layer invents no new behavior of its own to get wrong —
it exposes behavior this project already had, which is also why
`sample_response`, covered below, turns out to be the least interesting tool
here rather than the most.

`@modelcontextprotocol/sdk` is an **optional peer dependency**, the same
shape `@anthropic-ai/sdk` has for baking (`docs/fixtures.md`). It is a
devDependency of this repo, so it resolves for every runnable example on this
page; a consumer of the published package only needs to install it if they
actually call `mcp()`. Without it, `mcp()` itself still returns a handle —
master §1 types it as synchronous, so a missing package cannot be reported
from inside the call — but the first thing that touches the SDK,
`connectStdio()` or the first HTTP request to the mount, throws:

```txt
mockingham: the MCP server needs @modelcontextprotocol/sdk, which is an
optional peer dependency. Install it with:

  npm install @modelcontextprotocol/sdk
```

## stdio

The shape most MCP clients expect — a subprocess talking JSON-RPC over
stdin/stdout:

```sh
mockingham mcp ./openapi.json
```

Nothing is written to stdout while this runs: stdout **is** the JSON-RPC
channel, so a stray log line would corrupt every message after it. All of
this subcommand's own logging — "MCP server ready for ...", warnings — goes
to stderr instead. It is the one place this project's usual logging
convention bends, and it bends for a protocol requirement rather than a
preference.

Add `--seed <s>` to pin generation, `--fixtures <dir>` to serve a fixture
store the way the plain server does, and `--write` to open the write gate
(§ below).

## http

`mcp()` mounts on the mock's **own** fetch surface rather than opening a
second port. That surface is `mock.fetch()` whether or not `listen()` has
ever been called, so the mount works before or after it — the dispatcher
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

`transport` defaults to `'inline'` — a server with no transport attached at
all, which is what a unit test wants and what the two tool-call examples
below build for themselves. `'stdio'` does not connect by itself: `mcp()`
only branches on `'http'` (`src/index.ts`), so a `'stdio'` handle still needs
an explicit `await handle.connectStdio()` before it talks JSON-RPC — which is
exactly what the `mockingham mcp` subcommand does on your behalf
(`src/server/cli.ts`). Only `'http'` writes anything into the mount slot.

## The fourteen tools

Seven read tools, always available:

- `list_operations` — method, path, `operationId`, summary, and tags for
  every operation; filter with `tag` or `pathPrefix`.
- `describe_operation` — the full contract for one operation: parameters,
  request body schema, every declared response schema, security
  requirements, declared examples.
- `search_operations` — free-text search over path, summary, description,
  and tags, ranked by where the match landed.
- `sample_response` — a live response from the real request pipeline. See
  the third item below.
- `get_auth_requirements` — the document's security schemes, plus one
  operation's own requirements when `operationId` is given.
- `list_webhooks` — declared webhooks and callbacks, with payload schemas
  and which operations are configured to emit them.
- `list_deliveries` — webhook deliveries recorded so far, oldest first,
  filterable by webhook name and outcome.

Seven write tools, gated behind `--write` (see below):

- `fail_next` — make the next request(s) to a target fail.
- `outage` — fail every request to a target for a window of time.
- `emit_webhook` — fire a declared webhook now, optionally at a chosen URL.
- `set_seed` — reshuffle every generated value, deterministically.
- `reset` — restore the configured baseline: armed failures, idempotency
  keys, counters, captured deliveries. Also clears runtime overrides.
- `set_override` — pin what an operation returns at runtime, without editing
  config. Layers over any configured override the same way `mock.override()`
  does. Target is a control-plane string: `"POST /orders"`, an operationId,
  or `"* /**"` for every operation.
- `clear_overrides` — remove runtime overrides set by `set_override`. With no
  target, clears every operation. Never touches the overrides in your config
  file.

`describe_operation`, `sample_response`, and `get_auth_requirements` all
identify an operation by `operationId`, or by `method` and `path` together.
Worth knowing before you rely on it: when `operationId` is supplied, it wins
outright — `method` and `path` are silently ignored rather than checked for
agreement with it, so passing an `operationId` alongside a mismatched
`method`/`path` pair does not raise anything (`src/mcp/tools/read.ts`,
`findOperation`).

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
project — no client library involved, because the mount is just another
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

**First: `--write` gates the seven write tools because they change the mock's
runtime state.** `fail_next`, `outage`, `emit_webhook`, `set_seed`, `reset`,
`set_override`, and `clear_overrides` all mutate something a second caller
would observe — an armed failure, a reseeded generator, a cleared store, a
runtime override. Read tools never do, so only the seven are behind the flag,
and the flag is off by default.

**Second: closing the gate does not hide the tools — it disables them, and
says so.** An agent that already knows a write tool's name still sees it in
`tools/list`; hiding the name and naming the flag that would enable it
cannot both happen, and the flag is the more useful half of that choice
(design §3.7):

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

Calling it anyway — `tools/call` on the disabled name — refuses, and the
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
structural instead (design §3.3): the tool builds a `Request` and hands it to
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
code path the no-drift design exists to prevent — `sample_response` would
then no longer show you what your real client is going to get.

## `list_webhooks` merges callbacks, and one of its fields needs care

`api.webhooks` — what `list_webhooks` reads from — is not only the
document's top-level `webhooks` object. `loadApi` folds every operation's
`callbacks` into the same map under their own names (`src/spec/load.ts`,
lines 147–161, and see `docs/webhooks.md`), so against `docs/example.json`
`list_webhooks` reports both `paymentFailed` (a top-level webhook) and
`paymentSucceeded` (`createPayment`'s callback) — not only the top-level one:

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
the callback is declared and nothing here is configured to emit it, so
`list_webhooks` falls back to the declaring operation (design §3.6). That
fallback only applies when nothing is configured: if some *other* operation's
`emits` config names a callback's webhook while its own declaring operation
has none, `emittedBy` reports only the configured operation and quietly drops
the declaring one — worth knowing if you configure `emits` yourself, though
nothing in this document does, so it does not show up above.

`payloadSchema` has a related sharp edge. Every other schema this server
emits — in `describe_operation`, for instance — falls back to
`{ "$comment": "not expressible as JSON Schema; this operation is generated
only" }` when the converter can't turn a schema into JSON Schema (a recursive
one, mainly). `list_webhooks`'s `payloadSchema` calls the converter directly
rather than through that fallback, so a recursive webhook payload comes back
as `payloadSchema: undefined` instead of the `$comment` placeholder
(`src/mcp/tools/read.ts`). Neither webhook in `docs/example.json` is
recursive, so it never appears above — it is worth knowing before you build
tooling against a document that has one.

## What isn't here yet

`regenerate_fixture` — a tool to save a live-generated response as a
committed fixture — is not part of this server. Nothing here is a
commitment to when it lands.
