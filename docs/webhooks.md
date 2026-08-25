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
a URL, is: an explicit `to:` on `emit()`, then a captured runtime URL, then a
configured `url`, then nothing (`unresolved`).

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
