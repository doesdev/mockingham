import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import { petstore } from '../fixtures/petstore.ts'

const api = loadApi(petstore)

function handler(options = {}) {
  return createHandler(api, { seed: 'respond', ...options })
}

test('respond replaces the whole response', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(202, { custom: true }) }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { custom: true })
})

test('respond may be async', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: async (ctx: any) => ctx.respond(200, { async: true }) }
    }
  })
  assert.deepEqual(await (await handle(new Request('http://mock/pets/7'))).json(), { async: true })
})

test('ctx.generate produces a seeded body inside the callback', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': {
        respond: (ctx: any) => {
          const body = ctx.generate(200) as Record<string, unknown>
          body['id'] = 1
          return ctx.respond(200, body)
        }
      }
    }
  })
  const body = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  assert.equal(body.id, 1)
  assert.equal(typeof body.name, 'string')
})

test('ctx.generate matches what the pipeline would have produced', async () => {
  const plain = await (await handler({})(new Request('http://mock/pets/7'))).json()
  const viaCallback = await (
    await handler({
      operations: { 'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(200, ctx.generate(200)) } }
    })(new Request('http://mock/pets/7'))
  ).json()
  assert.deepEqual(viaCallback, plain)
})

test('ctx.seq increments across requests', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(200, { n: ctx.seq('pet') }) }
    }
  })
  const first = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  const second = (await (await handle(new Request('http://mock/pets/7'))).json()) as any
  assert.equal(first.n, 1)
  assert.equal(second.n, 2)
})

test('respond receives the parsed request body', async () => {
  const handle = handler({
    operations: { createPet: { respond: (ctx: any) => ctx.respond(201, ctx.body) } }
  })
  const response = await handle(new Request('http://mock/pets', {
    method: 'POST',
    body: '{"name":"Rex"}',
    headers: { 'content-type': 'application/json' }
  }))
  assert.deepEqual(await response.json(), { name: 'Rex' })
})

test('a callback returning a plain Response is used as-is', async () => {
  const handle = handler({
    operations: {
      'GET /pets/{petId}': { respond: () => new Response('raw', { status: 418 }) }
    }
  })
  const response = await handle(new Request('http://mock/pets/7'))
  assert.equal(response.status, 418)
  assert.equal(await response.text(), 'raw')
})

test('an operation without respond is unaffected', async () => {
  const handle = handler({
    operations: { 'GET /pets/{petId}': { respond: (ctx: any) => ctx.respond(202) } }
  })
  const response = await handle(new Request('http://mock/pets'))
  assert.equal(response.status, 200)
})
