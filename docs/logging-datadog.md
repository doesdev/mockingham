# Shipping logs to Datadog

Every request the mock answers can produce one structured log record —
`onLog` receives it after the response is final, and nothing about receiving
it can change what the caller got back. This guide builds a sink that shapes
each record for Datadog's Logs API, posts a batch to it in one shot, and
survives the sink itself misbehaving; it also describes — in prose, not as
runnable code — how a real batching sink adds triggers to flush on size, on
an interval, and on close.

## The `LogRecord` fields

`LogRecord` (`src/runtime/logging.ts`) is what `onLog` receives, once per
request:

| Field | Type | What it is |
|---|---|---|
| `ts` | `number` | When the request started, from the injected clock. |
| `durationMs` | `number` | How long handling took, from the same clock. |
| `requestId` | `string` | A 16-character hex id, hashed from request identity rather than random — see below. |
| `method` | `string` | The HTTP method. |
| `route` | `string` | The **templated** path. Safe as a tag. |
| `path` | `string` | The **resolved** path. Not safe as a tag. |
| `status` | `number` | The response status actually sent. |
| `bytesIn` | `number` | Request body size. |
| `bytesOut` | `number` | Serialized response body size; headers are not counted. |
| `params` | `Record<string, string>` | Resolved path parameters. |
| `query` | `Record<string, string \| string[]>` | Resolved query parameters. |
| `seed` | `string` | The seed in effect for this request. |
| `operationId?` | `string` | Absent when no operation matched. |
| `decisions` | `Decisions` | What each pipeline stage decided — `auth`, `failure`, and so on. |
| `error?` | `string` | Set only when `produce()` itself threw. |
| `custom` | `Record<string, unknown>` | `ctx.log` contributions — see below. |

`ts` and `durationMs` come from the same injected clock and sit outside the
determinism invariant by design: a log record is an observational side
channel that never enters a response (`src/runtime/logging.ts`, citing the
phases 7-9 design §2.1). A real clock makes `durationMs` genuinely variable
run to run, which is why it stays out of the runnable examples below — but
worth knowing: `durationMs` is `now() - startedAt` computed from the exact
same injected `now`, so under the fixed clock every example here uses,
`durationMs` is not merely stable, it is always `0`. `requestId` is not
random either, and for a different reason worth calling out: it is
`hash(requestKey, ordinal)` precisely because a caller may echo it on a
correlation header, and a random value there would break the determinism
invariant the moment logging was switched on.

## The reason this recipe exists: `route` versus `path`

This is worth its own section rather than a passing mention, because getting
it backwards is how a mock server produces a surprising metrics bill.

`route` is the **templated** path — `/payments/{id}`, not
`/payments/7c8f1f5e-...` — and is bounded by the document: one value per
operation, forever. That is what makes it safe to use as a tag (`ddtags`,
a Prometheus label, anything a time-series backend indexes on). `path` is
the **resolved** path a specific caller actually hit. It is unbounded — one
distinct value per UUID, per customer id, per anything a path parameter
happens to carry — and indexing on an unbounded value is exactly what turns
a metrics bill into an incident. The source states both halves of this in
its own comments: `route` is documented as "a bounded tag," `path` as
"high cardinality, never a tag" (`src/runtime/logging.ts`).

When no operation matches at all, `route` falls back to the literal string
`'<unmatched>'` — still one bounded value, so an attacker throwing random
paths at the mock cannot blow up tag cardinality either. Log `path` for
debugging a specific request; tag on `route`, `status`, and `operationId`
for everything aggregate.

## A batching Datadog sink

The clock is fixed so `ts` is stable across runs, and note what is
deliberately *not* passed here: `fetch` is an option `createMock` forwards
to webhook delivery and the LLM content source, not to `onLog` — nothing
about shipping logs runs through it. The flush function below reaches for
its own injected `fetch` directly, from scope.

`getPayment` requires a bearer credential. The first call below sends none,
so auth stage short-circuits it into a `401` before the operation's own
response logic ever runs — and that short-circuited record is itself worth
seeing: an operator watching Datadog wants to know about the request that
never got in, not only the ones that did. The second call supplies
`Authorization` and also demonstrates `ctx.log`, covered just after. The
third call hits a path no operation declares at all, to show `route` falling
back to `'<unmatched>'`:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))

const batch: Record<string, unknown>[] = []

const mock = createMock(doc, {
  seed: 'docs',
  now: () => 1_767_225_600_000,
  onLog: (record) => {
    batch.push({
      ddsource: "mockingham",
      service: 'payments-mock',
      ddtags: `route:${record.route},status:${record.status}`,
      message: `${record.method} ${record.route} ${record.status}`,
      request_id: record.requestId,
      operation_id: record.operationId ?? null,
      custom: record.custom
    })
  },
  operations: {
    getPayment: {
      respond: (ctx) => {
        ctx.log['tenantId'] = 'acme-042'
        return ctx.respond(200, ctx.generate(200))
      }
    }
  }
})

await mock.fetch(
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30')
)
await mock.fetch(
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30', {
    headers: { authorization: 'Bearer test-token' }
  })
)
await mock.fetch(new Request('http://mock/nope'))

console.log(JSON.stringify(batch, null, 2))
```

```console
[
  {
    "ddsource": "mockingham",
    "service": "payments-mock",
    "ddtags": "route:/payments/{id},status:401",
    "message": "GET /payments/{id} 401",
    "request_id": "59a9a361c6006d73",
    "operation_id": "getPayment",
    "custom": {}
  },
  {
    "ddsource": "mockingham",
    "service": "payments-mock",
    "ddtags": "route:/payments/{id},status:200",
    "message": "GET /payments/{id} 200",
    "request_id": "56a99ea852485104",
    "operation_id": "getPayment",
    "custom": {
      "tenantId": "acme-042"
    }
  },
  {
    "ddsource": "mockingham",
    "service": "payments-mock",
    "ddtags": "route:<unmatched>,status:404",
    "message": "GET <unmatched> 404",
    "request_id": "002dc7f198aa5b43",
    "operation_id": null,
    "custom": {}
  }
]
```

The first record is exactly the "who tried to get in without credentials"
line an operator reaches for first. The second shows `operationId` present
and `custom` carrying what `ctx.log` set. The third shows the unmatched
fallback: `route` is the bounded `'<unmatched>'`, never the raw path that
was actually requested.

## `ctx.log` becomes `record.custom`

`ctx.log` (`src/runtime/context.ts`) starts as `{}` on every request — a
plain mutable object exposed on `Ctx`, there for exactly this: any override
function that receives `ctx` can write to it, and whatever is there when the
response goes out lands verbatim in `record.custom`. Above,
`operations.getPayment.respond` set `tenantId` before calling `ctx.respond`;
nothing else about the response changed, because `ctx.generate(200)` still
produces the normal seeded body underneath it.

## Flushing to Datadog

The flush function is deliberately plain: it takes the batch and an
injected `fetch`, and posts once. Nothing about `createMock` is involved —
this call happens entirely outside it:

```ts
const sent: { url: string; headers: Record<string, string>; body: string }[] = []

const fakeFetch: typeof fetch = async (input, init) => {
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value
  })
  sent.push({ url: String(input), headers, body: String(init?.body ?? '') })
  return new Response(null, { status: 202 })
}

async function flushToDatadog(
  records: Record<string, unknown>[],
  apiKey: string,
  fetchImpl: typeof fetch
): Promise<void> {
  if (records.length === 0) return
  await fetchImpl('https://http-intake.logs.datadoghq.com/api/v2/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'DD-API-KEY': apiKey },
    body: JSON.stringify(records)
  })
}

await flushToDatadog(batch, 'test-key', fakeFetch)
console.log(JSON.stringify(sent, null, 2))
```

```console
[
  {
    "url": "https://http-intake.logs.datadoghq.com/api/v2/logs",
    "headers": {
      "content-type": "application/json",
      "dd-api-key": "test-key"
    },
    "body": "[{\"ddsource\":\"mockingham\",\"service\":\"payments-mock\",\"ddtags\":\"route:/payments/{id},status:401\",\"message\":\"GET /payments/{id} 401\",\"request_id\":\"59a9a361c6006d73\",\"operation_id\":\"getPayment\",\"custom\":{}},{\"ddsource\":\"mockingham\",\"service\":\"payments-mock\",\"ddtags\":\"route:/payments/{id},status:200\",\"message\":\"GET /payments/{id} 200\",\"request_id\":\"56a99ea852485104\",\"operation_id\":\"getPayment\",\"custom\":{\"tenantId\":\"acme-042\"}},{\"ddsource\":\"mockingham\",\"service\":\"payments-mock\",\"ddtags\":\"route:<unmatched>,status:404\",\"message\":\"GET <unmatched> 404\",\"request_id\":\"002dc7f198aa5b43\",\"operation_id\":null,\"custom\":{}}]"
  }
]
```

`Headers` lower-cases every name it stores, which is why `DD-API-KEY` above
comes back as `dd-api-key` — the real Datadog intake reads headers
case-insensitively, same as every other HTTP server, so this is cosmetic
only.

## A sink failure never reaches the response

`onError` exists so that a sink which throws, or returns a rejected
promise, cannot turn into a broken response. `emitLog`
(`src/runtime/logging.ts`) calls the sink, and — its own comment is exact
about why this matters — "a bare floating promise turns a logger's
rejection into an unhandled rejection, which can take the process down," so
the rejection is routed to `onError` explicitly rather than left to float:

```ts
const sinkErrors: string[] = []

const brokenMock = createMock(doc, {
  seed: 'docs',
  now: () => 1_767_225_600_000,
  onLog: () => {
    throw new Error('datadog intake unreachable')
  },
  onError: (error) => {
    sinkErrors.push(error instanceof Error ? error.message : String(error))
  }
})

const brokenResponse = await brokenMock.fetch(
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30', {
    headers: { authorization: 'Bearer test-token' }
  })
)
console.log(`response status despite the throw: ${brokenResponse.status}`)
console.log(`onError saw: ${sinkErrors[0]}`)

await brokenMock.close()
```

```console
response status despite the throw: 200
onError saw: datadog intake unreachable
```

The `200` is exactly what the same request would have returned with no
`onLog` configured at all — a broken sink is a logging problem, never a
caller-visible one.

## Flushing on size, on an interval, and on close

A real sink rarely posts once per request — it batches. The shape is the
same regardless of what triggers a flush: push the shaped record onto a
pending array, and flush it (POST, clear the array) when the array reaches
some size, on a timer, or when the mock is shutting down and anything left
pending needs to go out before the process exits. A timer registered for
this should be `unref()`'d, the same way any interval a library starts on a
caller's behalf should be, so a batching sink never becomes the reason a
short-lived script hangs.

`onLog` returning a promise is awaited — `emitLog` chains `.catch()` onto
it — but "awaited" here does not mean the response waits for it. The call
to `sink(record)` happens after the response has already been built, and
the caller's `fetch()` returns without ever pausing on the sink's promise:
a slow flush delays nothing but the next flush. Rather than take that on
faith, here is the ordering a slow sink actually produces — `onLog` below
does not resolve until a macrotask later, and the log of what happened
when shows the response returning first regardless:

```ts
const order: string[] = []
let sinkSettled: () => void = () => {}
const sinkSettledPromise = new Promise<void>((resolve) => {
  sinkSettled = resolve
})

const slowMock = createMock(doc, {
  seed: 'docs',
  now: () => 1_767_225_600_000,
  onLog: async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push('sink flushed')
    sinkSettled()
  }
})

const slowResponse = await slowMock.fetch(
  new Request('http://mock/payments/7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30', {
    headers: { authorization: 'Bearer test-token' }
  })
)
order.push('response returned')
console.log(`response status while the sink is still flushing: ${slowResponse.status}`)
console.log(`order before the sink finishes: ${JSON.stringify(order)}`)

await sinkSettledPromise
order.push('sink observed complete')
console.log(`order once the sink has actually finished: ${JSON.stringify(order)}`)

await slowMock.close()
await mock.close()
```

```console
response status while the sink is still flushing: 200
order before the sink finishes: ["response returned"]
order once the sink has actually finished: ["response returned","sink flushed","sink observed complete"]
```

"response returned" is already in `order` before the sink has done
anything at all. Nothing about how slow `onLog` is changes what the caller
received or when they received it.
