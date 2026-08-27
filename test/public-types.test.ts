import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMock } from '../src/index.ts'
import type {
  Ctx,
  Directive,
  EmitConfig,
  EmitCtx,
  EmitOptions,
  FailurePolicy,
  CircuitPolicy,
  HandlerOptions,
  MockOptions,
  OperationConfig,
  OverrideNode,
  Resolver,
  Resolvers,
  StatusConfig,
  Store
} from '../src/index.ts'

/**
 * `exports` declares `.` and `./package.json` only, so a consumer has exactly
 * one place to import from. Every type needed to WRITE a typed handler has to
 * be nameable from there, or the choice between `any` and a locally restated
 * copy of our interfaces is the whole of a consumer's TypeScript story - and a
 * restated copy rots silently on the next release.
 *
 * These assertions are enforced by `npm run typecheck`, not by `node --test`:
 * types are stripped, not checked, when the suite runs. A missing re-export in
 * `src/index.ts` is a tsc error here, which is why the file matters even though
 * every runtime assertion in it is trivial.
 */

const handler = async (ctx: Ctx): Promise<Response> => {
  // The two ends of the wire are WHATWG types, not ours: `req` is a Request and
  // `respond` resolves to a Response. Asserting that here keeps a later change
  // that wraps either one in a library type from passing unnoticed.
  const method: string = ctx.req.method
  const id: string = ctx.params['id'] ?? ctx.requestId
  ctx.log['method'] = method
  return ctx.respond(200, { id, n: ctx.seq('orders') })
}

const status: StatusConfig = {
  body: { total: 0 } satisfies OverrideNode,
  headers: { 'x-source': (ctx: Ctx) => ctx.operation.operationId }
}

const emit: EmitConfig = {
  webhook: 'order.created',
  afterMs: (ctx: EmitCtx) => (ctx.result.status === 200 ? 0 : 10),
  body: { id: (ctx: EmitCtx) => ctx.requestId }
}

const operation: OperationConfig = {
  status: 200,
  respond: handler,
  emits: [emit],
  200: status
}

const byFormat: Resolver = (ctx: Ctx) => ctx.rng.int(1, 10)
const resolvers: Resolvers = {
  byFormat: { 'order-id': byFormat },
  byName: [[/^total$/, () => 0]],
  bySchema: { Order: { id: byFormat } }
}

const circuit: CircuitPolicy = { after: 5, openFor: 1_000, then: 503 }
const failure: FailurePolicy[] = [{ match: '* /**', rate: 0, circuit }]

const decide = (ctx: Ctx): Directive | undefined =>
  ctx.headers['x-force-503'] === '1' ? { status: 503, code: 'forced' } : undefined

// Assembled as HandlerOptions first, then widened into MockOptions, because
// `operations` is public while `OperationConfig` - its value type - was not.
const options: HandlerOptions = {
  operations: { '* /**': operation },
  resolvers,
  failure,
  decide
}
const mockOptions: MockOptions = { ...options, llm: { mode: 'off' } }

const doc = {
  openapi: '3.1.0',
  info: { title: 'types', version: '1' },
  webhooks: {
    'order.created': {
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
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string' }, n: { type: 'integer' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

test('a handler written entirely against root-exported types serves', async () => {
  const mock = createMock(doc, mockOptions)
  // `Store` is the declared type of `Mock.store`, so a consumer holding one in
  // a variable of that name is exactly the case the export exists for.
  const store: Store = mock.store
  await store.set('probe', 1)

  const response = await mock.fetch(new Request('http://x/orders/abc'))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 'abc', n: 1 })
  await mock.close()
})

test('emit options are nameable, so an emit call can be typed', async () => {
  const mock = createMock(doc, { llm: { mode: 'off' } })
  const emitOptions: EmitOptions = { scope: undefined }
  const delivery = await mock.emit('order.created', emitOptions)
  assert.equal(delivery.outcome, 'unresolved')
  await mock.close()
})
