import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResponders } from '../../src/runtime/pipeline.ts'
import type { Operation, ResponseSpec } from '../../src/spec/types.ts'

function spec(status: number): ResponseSpec {
  return {
    status,
    headers: {},
    content: {
      'application/json': {
        schema: { type: 'object', properties: { a: { type: 'string' } } },
        examples: { empty: { value: { a: '' } } }
      }
    }
  }
}

function operation(responses: ResponseSpec[]): Operation {
  return { method: 'get', path: '/x', parameters: [], responses, callbacks: [] }
}

function build(responses: ResponseSpec[], prefer?: string) {
  return createResponders({
    operation: operation(responses),
    request: new Request('http://mock/x', prefer ? { headers: { prefer } } : undefined),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {}
  })
}

test('selection is memoized', () => {
  // selectResponse builds a fresh { spec, source } each call, so identity across
  // two calls is proof the second one did not recompute. Laziness itself is
  // proven behaviorally by test/server/stage-order.test.ts — an unauthenticated
  // request to a response-less operation gets 401 rather than the 501 that only
  // an eager selection could produce.
  const responders = build([spec(200)])
  assert.strictEqual(responders.selection(), responders.selection())
})

test('selection returns undefined when the operation declares nothing', () => {
  assert.equal(build([]).selection(), undefined)
})

test('generate produces a value for the selected status', () => {
  const value = build([spec(200)]).generate() as Record<string, unknown>
  assert.equal(typeof value['a'], 'string')
})

test('generate for an explicit status uses that response', () => {
  const responders = build([spec(200), spec(404)])
  assert.equal(typeof (responders.generate(404) as Record<string, unknown>)['a'], 'string')
})

test('generate returns undefined when nothing is selected', () => {
  assert.equal(build([]).generate(), undefined)
})

test('generate returns undefined for a status with no JSON content', () => {
  const responders = createResponders({
    operation: operation([{ status: 204, headers: {}, content: {} }]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {}
  })
  assert.equal(responders.generate(), undefined)
})

test('example returns a named example', () => {
  assert.deepEqual(build([spec(200)]).example(200, 'empty'), { a: '' })
})

test('example returns undefined for an unknown name', () => {
  assert.equal(build([spec(200)]).example(200, 'nope'), undefined)
})

test('rngFor is stable for the same label', () => {
  const responders = build([spec(200)])
  assert.equal(responders.rngFor('a').next(), responders.rngFor('a').next())
})

test('rngFor differs across labels', () => {
  const responders = build([spec(200)])
  assert.notEqual(responders.rngFor('a').next(), responders.rngFor('b').next())
})

test('Prefer still selects a declared status', () => {
  assert.equal(build([spec(200), spec(404)], 'status=404').selection()?.spec.status, 404)
})

test('generate returns a whole-body fixture instead of generating', () => {
  let calls = 0
  const responders = createResponders({
    operation: operation([spec(200)]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {},
    fixture: (status) => {
      calls += 1
      return status === 200 ? { fixed: true } : undefined
    }
  })
  assert.deepEqual(responders.generate(), { fixed: true })
  assert.equal(calls, 1)
})

test('generate falls through to generation when the fixture hook returns undefined', () => {
  const responders = createResponders({
    operation: operation([spec(200)]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {},
    fixture: () => undefined
  })
  const value = responders.generate() as Record<string, unknown>
  assert.equal(typeof value['a'], 'string')
})

test('generate is unchanged when no fixture hook is supplied', () => {
  const value = build([spec(200)]).generate() as Record<string, unknown>
  assert.equal(typeof value['a'], 'string')
})

test('generate honors a falsy-but-defined fixture value rather than treating it as a miss', () => {
  // null is a legitimate whole-body fixture; only undefined means "fall through".
  const responders = createResponders({
    operation: operation([spec(200)]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {},
    fixture: (status) => (status === 200 ? null : undefined)
  })
  assert.equal(responders.generate(), null)
})

test('generate consults the fixture before the media-type lookup', () => {
  // status 999 is not declared on the operation at all, so mediaFor(999)
  // would find nothing — proof the fixture answers even where the media
  // lookup could not have.
  //
  // This deliberately does NOT use a body-less (204-style) status anymore:
  // resolve() itself now skips fixture resolution entirely for a status with
  // no JSON content (design: "Responses with no body ... skip fixture
  // resolution entirely"), so a real caller's `fixture` hook — wired to
  // resolve()/peek() — never hands back a value for one. This test only
  // pins createResponders' OWN call ordering (fixture before mediaFor),
  // independent of what resolve() chooses to serve; an explicit status
  // argument bypasses selectResponse entirely, so `999` never needs to be a
  // status the operation could plausibly select on its own.
  //
  // Read plainly: after the body-less-response fix, no real caller can ever
  // produce the shape this test exercises — a wired-up `fixture` hook never
  // returns a value for a status `mediaFor` also can't find, since both now
  // agree on "no JSON content means no fixture". The ordering this pins is
  // therefore a short-circuit optimization inside `generate()`, not a
  // reachable correctness case; do not read the synthetic status `999` below
  // as a modeled real-world scenario.
  const responders = createResponders({
    operation: operation([spec(200)]),
    request: new Request('http://mock/x'),
    staticStatus: undefined,
    key: 'k',
    generateOptions: {},
    fixture: (status) => (status === 999 ? { fixed: true } : undefined)
  })
  assert.deepEqual(responders.generate(999), { fixed: true })
})
