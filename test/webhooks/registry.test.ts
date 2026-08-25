import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../../src/webhooks/registry.ts'
import type { Registry } from '../../src/webhooks/registry.ts'
import { createMemoryStore } from '../../src/runtime/store.ts'
import type { Store } from '../../src/runtime/store.ts'
import { createRng } from '../../src/generate/rng.ts'
import { loadApi } from '../../src/spec/load.ts'
import { callbackKey, emitWebhook, resolveWebhook } from '../../src/webhooks/emit.ts'
import { createMock } from '../../src/index.ts'

test('a registration is readable back at its scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), 'https://a.example/h')
})

test('scopes do not collide', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  await registry.register('orderChanged', 'https://b.example/h', 'tenant-2')
  // Two tenants in the fixture, because a registry with one scope cannot
  // prove it is keyed by scope at all.
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), 'https://a.example/h')
  assert.equal(await registry.lookup('orderChanged', 'tenant-2'), 'https://b.example/h')
})

test('unregister removes only its own scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('orderChanged', 'https://a.example/h', 'tenant-1')
  await registry.register('orderChanged', 'https://b.example/h', 'tenant-2')
  await registry.unregister('orderChanged', 'tenant-1')
  assert.equal(await registry.lookup('orderChanged', 'tenant-1'), undefined)
  assert.equal(await registry.lookup('orderChanged', 'tenant-2'), 'https://b.example/h')
})

test('all() is sorted by webhook then scope', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  // Inserted out of order on purpose: invariant 2 forbids an unordered
  // iteration deciding anything observable, and all() is observable.
  await registry.register('zeta', 'https://z.example/h', 'b')
  await registry.register('alpha', 'https://a2.example/h', 'b')
  await registry.register('alpha', 'https://a1.example/h', 'a')
  assert.deepEqual(await registry.all(), [
    { webhook: 'alpha', url: 'https://a1.example/h', scope: 'a' },
    { webhook: 'alpha', url: 'https://a2.example/h', scope: 'b' },
    { webhook: 'zeta', url: 'https://z.example/h', scope: 'b' }
  ])
})

test('all(name) filters to one webhook', async () => {
  const registry = createRegistry(createMemoryStore(() => 0))
  await registry.register('alpha', 'https://a.example/h', 'a')
  await registry.register('zeta', 'https://z.example/h', 'b')
  assert.deepEqual(await registry.all('zeta'), [
    { webhook: 'zeta', url: 'https://z.example/h', scope: 'b' }
  ])
})

test('all() reads the value back through the Store rather than an in-process copy', async () => {
  // The key index is process-local (design §3.5, §13.1) but the VALUE is
  // authoritative in the Store. A write behind the registry's back must be
  // reflected, or a shared Store would serve a stale destination.
  const store = createMemoryStore(() => 0)
  const registry = createRegistry(store)
  await registry.register('alpha', 'https://old.example/h', 'a')
  await store.set('registration|alpha|a', 'https://new.example/h')
  assert.deepEqual(await registry.all(), [
    { webhook: 'alpha', url: 'https://new.example/h', scope: 'a' }
  ])
})

test('a value cleared out of the Store stops being enumerated', async () => {
  // reset() clears the Store without going through the registry, so the index
  // must not resurrect a registration the Store no longer holds.
  const store = createMemoryStore(() => 0)
  const registry = createRegistry(store)
  await registry.register('alpha', 'https://a.example/h', 'a')
  await store.clear()
  assert.deepEqual(await registry.all(), [])
})

// ---------------------------------------------------------------------------
// The destination tier.

const api = loadApi({
  openapi: '3.1.0',
  webhooks: {
    w: { post: { responses: { '200': { description: 'ok' } } } }
  },
  paths: {}
})

function harness() {
  return {
    fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {}
  }
}

async function urlFor(
  input: { store: Store; registry: Registry; to?: string; scope?: string; url?: string }
): Promise<string | undefined> {
  const h = harness()
  const delivery = await emitWebhook({
    name: 'w',
    api,
    config: resolveWebhook({ url: input.url }),
    store: input.store,
    registry: input.registry,
    scope: input.scope,
    to: input.to,
    captureOnly: true,
    seed: 'plan11',
    ordinal: 1,
    rng: createRng('t'),
    generateOptions: { schemaNames: api.schemaNames },
    fetch: h.fetch,
    sleep: h.sleep,
    now: () => 1_700_000_000
  })
  return delivery.url
}

test('a registration beats a captured callback but loses to an explicit to', async () => {
  // Three tiers armed at once; each assertion removes the tier above it.
  // A test arming only one tier cannot prove an ORDER.
  const store = createMemoryStore(() => 0)
  const registry = createRegistry(store)
  await registry.register('w', 'https://registered.example/h')
  await store.set(callbackKey('w'), 'https://captured.example/h')
  assert.equal(
    await urlFor({ store, registry, url: 'https://config.example/h' }),
    'https://registered.example/h'
  )
  assert.equal(
    await urlFor({ store, registry, url: 'https://config.example/h', to: 'https://explicit.example/h' }),
    'https://explicit.example/h'
  )
})

test('an emission for a scope with no registration falls through to the captured tier', async () => {
  const store = createMemoryStore(() => 0)
  const registry = createRegistry(store)
  await registry.register('w', 'https://registered.example/h', 'tenant-1')
  await store.set(callbackKey('w'), 'https://captured.example/h')
  assert.equal(await urlFor({ store, registry, scope: 'tenant-1' }), 'https://registered.example/h')
  assert.equal(await urlFor({ store, registry, scope: 'tenant-2' }), 'https://captured.example/h')
})

// ---------------------------------------------------------------------------
// End to end, through the public surface.

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  webhooks: {
    orderStatusChanged: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { id: { type: 'string' } } }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      }
    }
  },
  paths: {
    '/subscriptions/{name}': {
      put: {
        operationId: 'setOrderSubscription',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { url: { type: 'string' } } }
            }
          }
        },
        responses: { '200': { description: 'ok' } }
      },
      delete: {
        operationId: 'deleteOrderSubscription',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { '204': { description: 'gone' } }
      }
    }
  }
}

function subscribe(url: string, tenant?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (tenant !== undefined) headers['x-tenant-id'] = tenant
  return new Request('http://mock/subscriptions/order-events', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ url })
  })
}

test('a registering operation supplies the destination a later emit delivers to', async () => {
  const mock = createMock(doc, {
    captureOnly: true,
    webhooks: {
      orderStatusChanged: {
        // Deliberately the BARE form, no braces: OpenAPI writes callback keys
        // this way and design §3.3 says both spellings must resolve.
        registerVia: { operationId: 'setOrderSubscription', url: '$request.body#/url' },
        unregisterVia: { operationId: 'deleteOrderSubscription' }
      }
    }
  })

  await mock.fetch(subscribe('https://consumer.example/hook'))
  const delivered = await mock.emit('orderStatusChanged')
  assert.equal(delivered.url, 'https://consumer.example/hook')
  assert.equal(delivered.outcome, 'captured')

  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderStatusChanged', url: 'https://consumer.example/hook', scope: '' }
  ])

  await mock.fetch(new Request('http://mock/subscriptions/order-events', { method: 'DELETE' }))
  const after = await mock.emit('orderStatusChanged')
  // Invariant 6 and design §3.6: nothing registered is `unresolved`, a normal
  // recorded Delivery - not a throw and not an onError.
  assert.equal(after.outcome, 'unresolved')
  assert.equal(after.url, undefined)
  assert.equal(after.error, undefined)
  assert.deepEqual(await mock.registrations(), [])
})

test('scopeBy keeps one tenant registration from redirecting another tenant webhooks', async () => {
  const errors: unknown[] = []
  const mock = createMock(doc, {
    captureOnly: true,
    onError: (error) => errors.push(error),
    webhooks: {
      orderStatusChanged: {
        registerVia: { operationId: 'setOrderSubscription', url: '{$request.body#/url}' },
        unregisterVia: { operationId: 'deleteOrderSubscription' },
        scopeBy: '{$request.header.x-tenant-id}'
      }
    }
  })

  await mock.fetch(subscribe('https://one.example/hook', 'tenant-1'))
  await mock.fetch(subscribe('https://two.example/hook', 'tenant-2'))

  assert.equal((await mock.emit('orderStatusChanged', { scope: 'tenant-1' })).url,
    'https://one.example/hook')
  assert.equal((await mock.emit('orderStatusChanged', { scope: 'tenant-2' })).url,
    'https://two.example/hook')
  // An emit with no scope addresses the unscoped registration, of which there
  // is none - design §3.4's third case.
  assert.equal((await mock.emit('orderStatusChanged')).outcome, 'unresolved')

  assert.deepEqual(await mock.registrations('orderStatusChanged'), [
    { webhook: 'orderStatusChanged', url: 'https://one.example/hook', scope: 'tenant-1' },
    { webhook: 'orderStatusChanged', url: 'https://two.example/hook', scope: 'tenant-2' }
  ])
  assert.deepEqual(errors, [])
})

test('register/unregister are also reachable imperatively', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await mock.register('orderStatusChanged', 'https://imperative.example/hook', 'tenant-1')
  assert.equal((await mock.emit('orderStatusChanged', { scope: 'tenant-1' })).url,
    'https://imperative.example/hook')
  await mock.unregister('orderStatusChanged', 'tenant-1')
  assert.equal((await mock.emit('orderStatusChanged', { scope: 'tenant-1' })).outcome, 'unresolved')
})

test('a registerVia url reading the RESPONSE body still registers', async () => {
  // The single exit only captures the response body when something declares a
  // need for it. Link rules were added to that gate; registry rules were not,
  // so a registerVia pointing at `$response.body` resolved against an
  // undefined body and silently registered NOTHING - an emit then fell through
  // to `unresolved` forever, with no error anywhere. Found by the Task 3
  // implementer as the same defect on the link path.
  // Cast through `unknown` because `doc`'s inferred literal type narrows this
  // response to `{ description: string }`. An OpenAPI document is data, not a
  // typed API surface - `loadApi` validates it at runtime.
  const responseDoc = structuredClone(doc) as unknown as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
  }
  responseDoc.paths['/subscriptions/{name}']!.put!.responses = {
    '200': {
      description: 'ok',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { url: { type: 'string', format: 'uri' } },
            required: ['url']
          }
        }
      }
    }
  }

  const mock = createMock(responseDoc as unknown as Record<string, unknown>, {
    captureOnly: true,
    webhooks: {
      orderStatusChanged: {
        registerVia: { operationId: 'setOrderSubscription', url: '{$response.body#/url}' }
      }
    }
  })

  const created = await mock.fetch(subscribe('https://ignored.example/hook'))
  const body = await created.json() as { url: string }

  // Pinned to the body the mock actually returned, not to a literal: the
  // assertion is that the registration is the value the RESPONSE minted.
  assert.deepEqual(await mock.registrations(), [
    { webhook: 'orderStatusChanged', url: body.url, scope: '' }
  ])
  assert.equal((await mock.emit('orderStatusChanged')).url, body.url)
})

test('registering an undeclared webhook name throws', async () => {
  // `emit` already throws on a name the document does not declare, because
  // that is a typo rather than a destination question. Registering one is the
  // same typo: it stores a destination nothing can ever deliver to, silently.
  // This codebase refuses that class elsewhere in the same words -
  // `assertValidOverrideKeys` rejects a key that "can never be read back and
  // would silently do nothing".
  const mock = createMock(doc, { captureOnly: true })
  await assert.rejects(
    () => mock.register('orderStatusChangd', 'https://typo.example/hook'),
    /no webhook named "orderStatusChangd" is declared/
  )
  // And the store is untouched, so the typo left nothing behind to confuse a
  // later `registrations()` reader.
  assert.deepEqual(await mock.registrations(), [])
})

test('unregistering an undeclared webhook name throws', async () => {
  const mock = createMock(doc, { captureOnly: true })
  await assert.rejects(
    () => mock.unregister('nosuchhook'),
    /no webhook named "nosuchhook" is declared/
  )
})

test('a registerVia target matching no operation throws at construction', async () => {
  assert.throws(
    () => createMock(doc, {
      webhooks: {
        orderStatusChanged: {
          registerVia: { operationId: 'setOrderSubscriptoin', url: '{$request.body#/url}' }
        }
      }
    }),
    /matches no operation/
  )
})
