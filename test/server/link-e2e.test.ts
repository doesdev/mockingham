import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../../src/index.ts'

const order = {
  type: 'object',
  properties: { id: { type: 'string' }, total: { type: 'integer' } },
  required: ['id', 'total']
}

const doc = {
  openapi: '3.1.0',
  info: { title: 'orders', version: '1' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } }
        },
        responses: {
          201: { description: 'made', content: { 'application/json': { schema: order } } }
        }
      }
    },
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: order } } },
          404: {
            description: 'gone',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { code: { type: 'string' } } }
              }
            }
          }
        }
      }
    }
  }
} as Record<string, unknown>

const link = [
  {
    from: { target: 'createOrder', key: '{$response.body#/id}' },
    to: { target: 'getOrder', key: '{$request.path.id}' }
  }
]

function post(mock: { fetch(request: Request): Promise<Response> }): Promise<Response> {
  return mock.fetch(new Request('http://mock/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  }))
}

test('an id minted by a POST resolves on the matching GET', async () => {
  // A control mock with the SAME seed and the SAME request sequence but no
  // `link` config. Generation is deterministic, so it says exactly what each
  // step would have produced without linking - which turns both halves of this
  // test into byte comparisons rather than into guesses about generated values.
  // (A bare `notEqual` on two generated ids is not enough: the generator draws
  // from a small word list, so two unrelated requests collide often enough to
  // make such a test pass by luck.)
  const mock = createMock(doc, { link, seed: 'link-e2e' })
  const plain = createMock(doc, { seed: 'link-e2e' })

  const created = await (await post(mock)).json() as { id: string; total: number }
  const plainCreated = await (await post(plain)).json() as { id: string }
  assert.deepEqual(plainCreated, created)

  const read = await (await mock.fetch(
    new Request(`http://mock/orders/${created.id}`))).json()
  assert.deepEqual(read, created)

  // The positive half is only meaningful if the same GET would NOT have
  // produced the created order on its own.
  const plainRead = await (await plain.fetch(
    new Request(`http://mock/orders/${created.id}`))).json()
  assert.notDeepEqual(plainRead, created)

  // The load-bearing half: an id the mock never minted must NOT recall. It
  // must produce exactly what the unlinked mock produces at the same point in
  // the same sequence. A recall that ignored its key would return the created
  // order here instead.
  const other = await (await mock.fetch(
    new Request('http://mock/orders/never-minted'))).text()
  const plainOther = await (await plain.fetch(
    new Request('http://mock/orders/never-minted'))).text()
  assert.equal(other, plainOther)
  assert.notDeepEqual(JSON.parse(other), created)
})

test('a GET before any POST generates rather than recalling', async () => {
  // The other direction of the miss: with nothing recorded at all, the read is
  // an ordinary generated response, not an error and not an empty body.
  const mock = createMock(doc, { link })
  const response = await mock.fetch(new Request('http://mock/orders/ord_x'))
  assert.equal(response.status, 200)
  const body = await response.json() as { id: string; total: number }
  assert.equal(typeof body.id, 'string')
  assert.equal(typeof body.total, 'number')
})

test('only a success status recalls', async () => {
  // Replaying a stored body into a 404 would be actively wrong - design §4.4.
  const mock = createMock(doc, { link })
  const created = await (await post(mock)).json() as { id: string }

  const response = await mock.fetch(new Request(`http://mock/orders/${created.id}`, {
    headers: { prefer: 'status=404' }
  }))
  assert.equal(response.status, 404)
  const body = await response.json() as Record<string, unknown>
  // The 404's own declared schema, not the recalled order.
  assert.equal(body.id, undefined)
  assert.equal(typeof body.code, 'string')
})

test('a config override refines a recalled body rather than being erased by it', async () => {
  // Precedence: runtime override > config override > link recall > fixture.
  const mock = createMock(doc, {
    link,
    operations: { getOrder: { 200: { body: { total: 4242 } } } }
  })
  const created = await (await post(mock)).json() as { id: string }
  const read = await (await mock.fetch(
    new Request(`http://mock/orders/${created.id}`))).json() as { id: string; total: number }
  assert.equal(read.id, created.id)
  assert.equal(read.total, 4242)
})

test('reset drops what was recalled', async () => {
  const mock = createMock(doc, { link, seed: 'link-reset' })
  const created = await (await post(mock)).json() as { id: string }
  const before = await (await mock.fetch(
    new Request(`http://mock/orders/${created.id}`))).json()
  assert.deepEqual(before, created)

  await mock.reset()

  const after = await (await mock.fetch(
    new Request(`http://mock/orders/${created.id}`))).json()
  assert.notDeepEqual(after, created)
})

test('the same request sequence produces byte-identical bodies across mocks', async () => {
  // Invariant 2 as amended by design §4.5: determinism is SEQUENCE-scoped.
  // Two independently constructed mocks, the SAME sequence, compared at every
  // step - not one response compared against itself.
  const first = createMock(doc, { link, seed: 'link-determinism' })
  const second = createMock(doc, { link, seed: 'link-determinism' })

  const bodiesA: string[] = []
  const bodiesB: string[] = []

  for (const mock of [first, second]) {
    const out = mock === first ? bodiesA : bodiesB
    const createdText = await (await post(mock)).text()
    out.push(createdText)
    const created = JSON.parse(createdText) as { id: string }
    out.push(await (await mock.fetch(
      new Request(`http://mock/orders/${created.id}`))).text())
    out.push(await (await mock.fetch(
      new Request('http://mock/orders/never-minted'))).text())
    out.push(await (await post(mock)).text())
  }

  assert.equal(bodiesA.length, 4)
  for (let i = 0; i < bodiesA.length; i++) {
    assert.equal(bodiesB[i], bodiesA[i], `step ${i} diverged`)
  }
  // And the sequence is not trivially constant: the recall step must differ
  // from the miss step, or "identical at every step" would prove nothing.
  assert.notEqual(bodiesA[1], bodiesA[2])
})
