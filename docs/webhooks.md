# Testing webhooks

A mock that only answers requests is half the contract. Real APIs also call
*you* — a payment settles, an order ships, a subscription you registered for
fires an event at a URL you gave it. This guide is about that outbound half:
declaring it, configuring where it goes, triggering it, and — the reason to
read this guide — testing it without a receiver, a port, or the network.

The frame for everything below is **CLAUDE.md invariant 6: emission never
affects the response.** Webhooks fire at the single exit, after the response
is final. A throw anywhere in an emit override, in signing, or in delivery
reaches `onError` — never the caller. An emit that resolves no destination is
captured, not thrown. Every example in this guide is really just that
invariant from a different angle.

## The two shapes, one lookup

OpenAPI has two ways to declare an outbound request:

- A **top-level `webhook`** — `docs/example.json` declares `paymentFailed`
  this way, as a path item under the document's `webhooks` key, the same
  shape a `paths` entry has.
- An **operation `callback`** — the same document's `createPayment` operation
  declares `paymentSucceeded` this way, keyed by a runtime expression
  (`{$request.body#/callbackUrl}`) rather than a literal path.

They read as different features. They are not, once loaded: `loadApi` merges
every operation's callbacks into `api.webhooks` under the callback's own
name, "so `emit()` has one place to look rather than two" (`src/spec/load.ts`,
lines 147–161). A top-level entry wins a name collision, on the reasoning
that it is the document's more explicit declaration of the same event. Below,
`mock.api.webhooks` holds both names from one document with no split between
them:

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'docs', captureOnly: true })

console.log(JSON.stringify(Object.keys(mock.api.webhooks).sort(), null, 2))
```

```console
[
  "paymentFailed",
  "paymentSucceeded"
]
```

What *does* differ between the two shapes is where a destination comes from,
covered next.

## Configuring a destination

A top-level webhook needs a URL from somewhere outside the request — nothing
in a `paymentFailed` request would ever carry one. Configure it under
`webhooks`, keyed by name:

```ts
const configured = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  webhooks: {
    paymentFailed: {
      url: 'https://example.test/hooks',
      headers: { 'x-source': 'mockingham' },
      retry: { attempts: 3 }
    }
  }
})

const manual = await configured.emit('paymentFailed')
console.log(JSON.stringify({ webhook: manual.webhook, url: manual.url, outcome: manual.outcome }, null, 2))
```

```console
{
  "webhook": "paymentFailed",
  "url": "https://example.test/hooks",
  "outcome": "captured"
}
```

`WebhookConfig` (`src/webhooks/emit.ts`) is `{ url?, secret?, retry?,
headers? }`, and `RetryConfig` is `{ attempts?, backoff?: 'exponential',
baseMs?, maxDelayMs? }` — `'exponential'` is the only backoff strategy, and a
one-value union documents that as deliberate rather than an oversight.
`attempts` is the TOTAL number of attempts, including the first — not
additional retries on top of it — and defaults to `3`; `baseMs` (default
`250`) and `maxDelayMs` (default `10_000`) bound the exponential backoff
between attempts (`src/webhooks/deliver.ts`).

A callback has no `url` to configure the same way, because its destination
is not static — it comes from a request. Emitting `paymentSucceeded` with
nothing subscribed and no config falls through every tier and resolves
`unresolved` rather than throwing:

```ts
const unresolved = await configured.emit('paymentSucceeded')
console.log(JSON.stringify({ webhook: unresolved.webhook, url: unresolved.url, outcome: unresolved.outcome }, null, 2))

await configured.close()
```

```console
{
  "webhook": "paymentSucceeded",
  "outcome": "unresolved"
}
```

Note `url` is simply absent from the printed object — `JSON.stringify` drops
an `undefined` property, and `Delivery.url` (`src/webhooks/deliver.ts`) is
typed optional for exactly this case: "absent when nothing resolved a
destination." `unresolved` is not a corner case worth skipping; it is what a
webhook with nowhere to go looks like, and it is worth its own example rather
than a footnote — invariant 6 again: nothing resolving is captured, not an
error.

A callback's destination instead comes from a **runtime expression**,
resolved against a live request. `createPayment`'s callback declares
`{$request.body#/callbackUrl}`, and the example document's request body has
a matching `callbackUrl` property for it to resolve against. A client that
POSTs its own callback URL is what makes this work:

```ts
const subscribeMock = createMock(doc, { seed: 'docs', captureOnly: true })
const subscribeRequest = new Request('http://mock/payments', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
  body: JSON.stringify({ amount: 10, currency: 'USD', callbackUrl: 'https://example.test/cb' })
})
await subscribeMock.fetch(subscribeRequest)

const captured = await subscribeMock.emit('paymentSucceeded')
console.log(JSON.stringify({ webhook: captured.webhook, url: captured.url, outcome: captured.outcome }, null, 2))

await subscribeMock.close()
```

```console
{
  "webhook": "paymentSucceeded",
  "url": "https://example.test/cb",
  "outcome": "captured"
}
```

The URL a request carried is captured at that request and used by a later
`emit()` — no config needed at all for a callback whose subscribers arrive at
runtime. Precedence across both shapes, when more than one tier could supply
a URL, is:

1. an explicit `to:` on `emit()`
2. a **registration** for the resolved scope (next section)
3. a captured runtime URL
4. a configured `url`
5. nothing — `unresolved`

A registration sits above a captured callback URL because it is a deliberate,
persistent statement about where a webhook goes, while a captured URL is
incidental to whichever request last happened to carry one. A document using
both is unusual; when it does, the explicit registration wins.

## The destination registry

A callback captures its destination from the request that triggers it. Plenty
of real APIs do not work that way: you `PUT` a subscription once, naming a URL,
and every later event goes there — a different operation entirely from the one
that fires the webhook. That is what a **registration** is.

Configure it under the webhook's own config with `registerVia` (which operation
registers, and the runtime expression that yields the URL), `unregisterVia`
(which operation removes it), and an optional `scopeBy` expression partitioning
registrations — per tenant, per account, per whatever the document keys
subscriptions on. `registerVia.operationId` is a control-plane target, not
strictly an operationId: `'PUT /subscriptions/{name}'` and `'* /subs/**'` both
work, and a target matching nothing throws at construction rather than silently
never registering.

The example document has no subscription operation, so this uses `createPayment`
as the registering one and `createRefund` as the unregistering one. Everything
below is exactly what a real `PUT /subscriptions/...` would do:

```ts
const registryMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  webhooks: {
    paymentFailed: {
      registerVia: { operationId: 'createPayment', url: '{$request.body#/callbackUrl}' },
      unregisterVia: { operationId: 'createRefund' },
      scopeBy: '{$request.header.x-tenant-id}'
    }
  }
})

function subscribeAs(tenant: string, callbackUrl: string): Request {
  return new Request('http://mock/payments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      'x-tenant-id': tenant
    },
    body: JSON.stringify({ amount: 10, currency: 'USD', callbackUrl })
  })
}

await registryMock.fetch(subscribeAs('acme', 'https://acme.test/hooks'))
await registryMock.fetch(subscribeAs('globex', 'https://globex.test/hooks'))

console.log(JSON.stringify(await registryMock.registrations(), null, 2))
```

```console
[
  {
    "webhook": "paymentFailed",
    "url": "https://acme.test/hooks",
    "scope": "acme"
  },
  {
    "webhook": "paymentFailed",
    "url": "https://globex.test/hooks",
    "scope": "globex"
  }
]
```

`registrations(name?)` returns entries **sorted by webhook then scope** — an
unordered iteration deciding an observable order is exactly what invariant 2
forbids, and this list is observable from a test, from the API, and from the
`list_registrations` MCP tool.

Two tenants, two destinations, no overwriting: that is what `scopeBy` buys. It
looks like a convenience and is not one. Without it both `PUT`s write the same
key and the second tenant silently redirects the first tenant's webhooks — a
wrong answer that looks like a working mock. An emission addresses one scope
with `emit(name, { scope })`, which wins over any configured `scopeBy` the same
way `to:` wins over any resolved destination:

```ts
const acmeDelivery = await registryMock.emit('paymentFailed', { scope: 'acme' })
const globexDelivery = await registryMock.emit('paymentFailed', { scope: 'globex' })
console.log(`acme: ${acmeDelivery.url}`)
console.log(`globex: ${globexDelivery.url}`)
```

```console
acme: https://acme.test/hooks
globex: https://globex.test/hooks
```

An `emit()` with no scope addresses the **unscoped** registration — the one
stored under the empty scope. Nothing registered there means nothing to send,
and — invariant 6 again — that is a `Delivery` with `outcome: 'unresolved'`,
not an error and not a throw:

```ts
const unscopedEmit = await registryMock.emit('paymentFailed')
console.log(JSON.stringify({ url: unscopedEmit.url, outcome: unscopedEmit.outcome }, null, 2))
```

```console
{
  "outcome": "unresolved"
}
```

This is worth being explicit about, because "nothing was registered" is the
state a registry spends most of its life in during a test, and it is easy to
assume it must be an error. It is not: `unresolved` is a distinct outcome from
a failure, it is recorded in `deliveries()` like any other, and `Delivery.status`
and `Delivery.error` are both absent for it — so a test can tell "went nowhere"
from "went somewhere and failed" without any extra machinery.

`unregisterVia` removes one scope's registration, keyed by the same expression
the registration was written under:

```ts
const unsubscribe = new Request('http://mock/refunds', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': 'test-key',
    'x-tenant-id': 'acme'
  },
  body: JSON.stringify({ paymentId: '7c8f1f5e-0d3a-4a1e-9f7a-2b6c1d5e4f30' })
})
await registryMock.fetch(unsubscribe)

console.log(JSON.stringify(await registryMock.registrations('paymentFailed'), null, 2))
```

```console
[
  {
    "webhook": "paymentFailed",
    "url": "https://globex.test/hooks",
    "scope": "globex"
  }
]
```

Acme is gone; globex is untouched. A test that wants to skip the request round
trip entirely can write the same entries directly — `mock.register(webhook,
url, scope?)` and `mock.unregister(webhook, scope?)` are the imperative form of
exactly what those two operations do, with an absent scope meaning the unscoped
registration:

```ts
await registryMock.register('paymentFailed', 'https://ops.test/hooks')
const nowResolved = await registryMock.emit('paymentFailed')
console.log(`unscoped emit now goes to: ${nowResolved.url}`)

await registryMock.unregister('paymentFailed')
const goneAgain = await registryMock.emit('paymentFailed')
console.log(`after unregister: ${goneAgain.outcome}`)

await registryMock.close()
```

```console
unscoped emit now goes to: https://ops.test/hooks
after unregister: unresolved
```

Two notes on the expression syntax and on scope. First, `{$request.body#/url}`
and the bare `$request.body#/url` resolve identically — OpenAPI's own
`callbacks` keys are written bare, so a reader coming from the spec will type
it that way, and the bare form is normalized by wrapping. Second, registrations
live in the `Store`, alongside `failNext` state and runtime overrides, so
`reset()` clears them for free and a shared Store shares the values across
processes. The *enumeration* is process-local: `registrations()` reads values
through the Store but its list of known keys is an in-process index, identical
in kind to the delivery log's own limitation. Another process's registration is
reflected in the value under a key this process knows; a key only that process
ever wrote will not appear in this one's listing.

## What triggers a fire

Two triggers, deliberately no more:

- **Imperative** — call `mock.emit(name, opts)` yourself, from a test or the
  control plane. `opts` is `{ to?, body? }`: an explicit destination and a
  body override layered over the generated payload, the same layering §4
  applies to a response.
- **Operation-linked** — declare `emits` on an operation's config, and it
  fires after that operation's response is returned, never before and never
  blocking it:

```ts
const loopMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  webhooks: { paymentFailed: { url: 'https://example.test/hooks' } },
  operations: {
    createPayment: { emits: [{ webhook: 'paymentFailed', afterMs: 50 }] }
  }
})

const orderRequest = new Request('http://mock/payments', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
  body: JSON.stringify({ amount: 20, currency: 'USD' })
})
const orderResponse = await loopMock.fetch(orderRequest)
console.log(`response returned before the emission fires: ${orderResponse.status}, deliveries: ${loopMock.deliveries().length}`)
```

```console
response returned before the emission fires: 201, deliveries: 0
```

`fetch()` has already resolved with a `201` while the delivery is still
`afterMs` away from firing — the response genuinely does not wait. That is
also what makes an operation-linked emission unobservable to a caller with
nothing else to reach for.

## The testing loop

`mock.settled()` is what a test reaches for. It drains every pending
emission — from either trigger — so a test has something to await instead
of polling `deliveries()` with a timeout:

```ts
await loopMock.settled()
console.log(`after settled(): ${loopMock.deliveries().length}`)
```

```console
after settled(): 1
```

The imperative trigger and `deliveries()`/`clearDeliveries()` complete the
loop. `deliveries()` returns oldest first; every delivery is recorded there
regardless of mode, which is what `captureOnly` is really for:

```ts
const manualDelivery = await loopMock.emit('paymentFailed')
await loopMock.settled()
console.log(JSON.stringify({ webhook: manualDelivery.webhook, url: manualDelivery.url, outcome: manualDelivery.outcome }, null, 2))

console.log(`captured so far: ${loopMock.deliveries().length}`)
loopMock.clearDeliveries()
console.log(`after clear: ${loopMock.deliveries().length}`)

await loopMock.close()
```

```console
{
  "webhook": "paymentFailed",
  "url": "https://example.test/hooks",
  "outcome": "captured"
}
captured so far: 2
after clear: 0
```

`Delivery` (`src/webhooks/deliver.ts`) is `{ id, webhook, url?, body, headers,
outcome, status?, attempts, error? }`. The `id` is one per emission, not per
attempt — a retry sequence is a single delivery with `attempts: n` and one id
— and it is derived from the seed, the webhook name and the emission ordinal
rather than being random, so replaying a sequence reproduces it. Print
`outcome`, not `status`: under
`captureOnly: true` nothing is actually sent over the network, so `status` —
an HTTP response code — is absent by design. Reaching for it here would teach
an expectation that never holds under capture mode; `captureOnly` is what
makes a webhook fully testable in-process with no receiver, the same way
`fetch()` made responses testable without a port.

## Delivery ids and redelivery

`mock.redeliver(id)` sends a recorded delivery again — the same bytes, the same
signature header, the same destination, and the same `id`. It does **not**
regenerate the payload and does not re-resolve the destination: the whole point
of a redelivery is proving your receiver's duplicate handling sees a duplicate,
and regenerating would defeat it.

The id is keyed on alone, without a webhook name beside it: the name is
recoverable from the record, and a two-argument form that could disagree with
itself is a defect surface for no benefit.

```ts
const redeliverMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  now: () => 1700000000000,
  webhooks: { paymentFailed: { url: 'https://example.test/hooks', secret: 'whsec_test' } }
})

const firstDelivery = await redeliverMock.emit('paymentFailed')
const secondDelivery = await redeliverMock.redeliver(firstDelivery.id)

console.log(`delivery id: ${firstDelivery.id}`)
console.log(`same id: ${firstDelivery.id === secondDelivery.id}`)
console.log(`same body: ${firstDelivery.body === secondDelivery.body}`)
console.log(`same signature: ${firstDelivery.headers['x-mockingham-signature'] === secondDelivery.headers['x-mockingham-signature']}`)
console.log(`records in the log: ${redeliverMock.deliveries().length}`)
```

```console
delivery id: 18684eae
same id: true
same body: true
same signature: true
records in the log: 2
```

That id is not random. It is derived from the seed, the webhook name, and the
per-webhook emission ordinal, so replaying the same sequence of requests in a
fresh process reproduces it exactly — the same reason nothing else in a
generation path reaches for a UUID. One id belongs to one **emission**, not to
one attempt: a retry sequence is a single delivery with `attempts: n` and one
id, which is what makes "did my receiver see this same event twice?" a question
with an answer.

The signature is replayed verbatim rather than recomputed. `sign` takes a
timestamp, so recomputing would produce a different header for identical bytes.
That is a real behavior in production systems, but it is not what "identical
bytes, identical id" asks for.

An id that is not in the log throws — including one that has aged out of the
1000-entry bound. Silently succeeding with nothing to send would be worse:

```ts
try {
  await redeliverMock.redeliver('not-a-real-delivery-id')
} catch (error) {
  console.log(`unknown id: ${error instanceof Error ? error.message : String(error)}`)
}

await redeliverMock.close()
```

```console
unknown id: mockingham: no delivery with id "not-a-real-delivery-id" is in the delivery log. Redeliver an id returned by emit() or listed by deliveries().
```

## Signing

Setting `secret` on a webhook's config turns signing on. The signature is
HMAC-SHA256 over `timestamp + '.' + rawBody`, sent as
`x-mockingham-signature: t=<timestamp>,v1=<hex>`. This exists so a client's
signature-verification path — the security-critical one — gets exercised
before production rather than after.

One implementation note worth citing precisely: the phases 8 design (§2.1)
amends the master spec's `node:crypto` to `crypto.subtle` instead. Signing is
reachable from the request pipeline, and invariant 3 forbids Node APIs
anywhere the handler imports from; `crypto.subtle` is a web API the core
already depends on, so it stays available without breaking that boundary.
The header format, the signed string, and the algorithm are unchanged — only
where the hashing runs moved.

A receiver verifies the same way any HMAC webhook is verified: recompute the
HMAC over the same string with the shared secret, and compare. Injecting a
fixed clock (`now`) makes the whole thing reproducible enough to hardcode the
expected signature below:

```ts
import { createHmac } from 'node:crypto'

const signedMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  now: () => 1700000000000,
  webhooks: { paymentFailed: { url: 'https://example.test/hooks', secret: 'whsec_test' } }
})

const signedDelivery = await signedMock.emit('paymentFailed')
const signatureHeader = signedDelivery.headers['x-mockingham-signature']
console.log(`${signatureHeader}`)

const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signatureHeader ?? '')
const timestamp = match?.[1] ?? ''
const receivedHex = match?.[2] ?? ''
const expectedHex = createHmac('sha256', 'whsec_test')
  .update(`${timestamp}.${signedDelivery.body}`)
  .digest('hex')
console.log(`signature verifies: ${receivedHex === expectedHex}`)

await signedMock.close()
```

```console
t=1700000000000,v1=d6332f6df57551c5f9d1b214f55bf165a19470e1da8d93d741c98e2da98a39c7
signature verifies: true
```

## Emission never affects the response

This is CLAUDE.md invariant 6, and it is worth seeing rather than taking on
faith. An emit override that throws — a bad body resolver, in this case —
never reaches the caller. It reaches `onError`, and the response that
triggered it is unaffected:

```ts
const errors: string[] = []
const guardedMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)) },
  operations: {
    createPayment: {
      emits: [{ webhook: 'paymentFailed', body: { amount: () => { throw new Error('signing gone wrong') } } }]
    }
  }
})

const guardedRequest = new Request('http://mock/payments', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
  body: JSON.stringify({ amount: 5, currency: 'USD' })
})
const guardedResponse = await guardedMock.fetch(guardedRequest)
await guardedMock.settled()

console.log(`response status despite the throw: ${guardedResponse.status}`)
console.log(`onError saw: ${errors[0]}`)
console.log(`deliveries recorded: ${guardedMock.deliveries().length}`)

await guardedMock.close()
```

```console
response status despite the throw: 201
onError saw: signing gone wrong
deliveries recorded: 0
```

The `201` came back exactly as it would have with no `emits` config at all —
the throw happened after the response was already final, in code the caller
never touches. Nothing was delivered and nothing was captured, because the
throw happened before `deliver()` was ever reached; there is no half-sent
delivery to record. Combined with the `unresolved` example earlier, both
halves of the invariant are covered: a delivery that goes nowhere is
captured, not an error, and a delivery that throws while being built never
becomes the caller's problem either.

## Known limitation: `reset()` and pending timers

`close()` cancels a pending emission outright — it clears the real timer
backing its `afterMs` wait, so a shutdown never waits one out. `reset()` only
bumps a generation counter; the emission is still correctly dropped once its
timer fires (the generation check catches it), but the underlying timer
itself keeps running. `settled()` called right after a `reset()` therefore
waits out the full `afterMs` rather than returning promptly — deferred item
25 in `docs/superpowers/deferred-items.md`, and a promptness gap rather than
a correctness one: nothing is delivered late or twice, an operation-linked
emission just outlives the `reset()` that was supposed to drop it sooner:

```ts
const resetMock = createMock(doc, {
  seed: 'docs',
  captureOnly: true,
  operations: {
    createPayment: { emits: [{ webhook: 'paymentFailed', afterMs: 300 }] }
  }
})

const resetRequest = new Request('http://mock/payments', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
  body: JSON.stringify({ amount: 1, currency: 'USD' })
})
await resetMock.fetch(resetRequest)

const resetStartedAt = Date.now()
await resetMock.reset()
await resetMock.settled()
const resetElapsedMs = Date.now() - resetStartedAt

console.log(`deliveries after reset(): ${resetMock.deliveries().length}`)
console.log(`settled() waited out the afterMs anyway: ${resetElapsedMs >= 300}`)

await resetMock.close()

await mock.close()
```

```console
deliveries after reset(): 0
settled() waited out the afterMs anyway: true
```

The delivery is still correctly dropped — `reset()` did its job, nothing
fired — but a test that resets between cases and immediately calls
`settled()` pays the `afterMs` cost anyway. Prefer `close()` over `reset()`
between cases where an emission may be pending, or keep `afterMs` small in
tests that reset.
