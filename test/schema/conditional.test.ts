import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompiler } from '../../src/schema/compile.ts'
import { generateValue } from '../../src/generate/generate.ts'
import { createRng } from '../../src/generate/rng.ts'
import { createHandler } from '../../src/server/handler.ts'
import { loadApi } from '../../src/spec/load.ts'
import type { Schema } from '../../src/spec/types.ts'

const SEEDS = Array.from({ length: 30 }, (_, index) => `s${index}`)

/** The consumer report's reproduction schema, verbatim. */
const shipment: Schema = {
  type: 'object',
  required: ['state', 'tags'],
  properties: {
    state: { type: 'string', enum: ['open', 'canceled'] },
    cancellationReason: { type: 'string' },
    tags: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string', enum: ['bulk', 'fragile'] }
    }
  },
  if: { properties: { state: { const: 'canceled' } }, required: ['state'] },
  then: { required: ['cancellationReason'] },
  else: { properties: { cancellationReason: false } }
}

function generate(schema: Schema, seed: string): Record<string, unknown> {
  return generateValue(schema, createRng(seed), { maxDepth: 12 }) as Record<
    string,
    unknown
  >
}

function parse(schema: Schema, value: unknown) {
  return createCompiler().compile(schema).safeParse(value)
}

test('generation honors the else branch, which forbids a property', () => {
  for (const seed of SEEDS) {
    const value = generate(shipment, seed)
    const present = 'cancellationReason' in value
    if (value.state === 'open') {
      assert.equal(present, false, `seed ${seed}: ${JSON.stringify(value)}`)
    } else {
      assert.equal(present, true, `seed ${seed}: ${JSON.stringify(value)}`)
    }
  }
})

// The report's key observation: `then` was never violated only because the
// generator emits every declared property, which happens to satisfy a `then`
// that merely REQUIRES one. A `then` that constrains a VALUE has no such luck.
const account: Schema = {
  type: 'object',
  required: ['kind', 'tier'],
  properties: {
    kind: { type: 'string', enum: ['premium', 'basic'] },
    tier: { type: 'string', enum: ['gold', 'silver'] }
  },
  if: { properties: { kind: { const: 'premium' } }, required: ['kind'] },
  then: { properties: { tier: { const: 'gold' } }, required: ['tier'] }
}

test('generation honors a then branch that constrains a value', () => {
  for (const seed of SEEDS) {
    const value = generate(account, seed)
    if (value.kind !== 'premium') continue
    assert.equal(value.tier, 'gold', `seed ${seed}: ${JSON.stringify(value)}`)
  }
})

// The other case the coincidence hides: a `then` requiring exactly the property
// the `else` forbids. Emitting every declared property satisfies `then` and
// violates `else`; omitting it does the reverse. Only a real branch decision
// gets both right.
const ticket: Schema = {
  type: 'object',
  required: ['closed'],
  properties: {
    closed: { type: 'boolean' },
    resolution: { type: 'string' }
  },
  if: { properties: { closed: { const: true } }, required: ['closed'] },
  then: { required: ['resolution'] },
  else: { properties: { resolution: false } }
}

test('generation satisfies whichever branch it took, over many seeds', () => {
  let sawTrue = false
  let sawFalse = false
  for (const seed of SEEDS) {
    const value = generate(ticket, seed)
    assert.equal(
      'resolution' in value,
      value.closed === true,
      `seed ${seed}: ${JSON.stringify(value)}`
    )
    if (value.closed === true) sawTrue = true
    else sawFalse = true
  }
  // Not a coverage assertion for its own sake: if generation always took one
  // branch, the test above would pass without the other branch ever running.
  assert.ok(sawTrue, 'no seed exercised the then branch')
  assert.ok(sawFalse, 'no seed exercised the else branch')
})

test('generated values validate against the same schema they came from', () => {
  const compiler = createCompiler()
  for (const schema of [shipment, account, ticket]) {
    const compiled = compiler.compile(schema)
    for (const seed of SEEDS) {
      const value = generate(schema, seed)
      const result = compiled.safeParse(value)
      assert.equal(
        result.success,
        true,
        `${JSON.stringify(value)} -> ${JSON.stringify(result.error?.issues)}`
      )
    }
  }
})

test('conditional generation is byte-identical for the same seed', () => {
  for (const seed of SEEDS) {
    assert.equal(
      JSON.stringify(generate(shipment, seed)),
      JSON.stringify(generate(shipment, seed))
    )
  }
})

test('validation rejects a body the else branch forbids', () => {
  const result = parse(shipment, {
    state: 'open',
    cancellationReason: 'x',
    tags: ['bulk', 'fragile']
  })
  assert.equal(result.success, false)
})

test('validation rejects a body the then branch requires more of', () => {
  const result = parse(shipment, {
    state: 'canceled',
    tags: ['bulk', 'fragile']
  })
  assert.equal(result.success, false)
})

test('validation rejects a then branch violated by a value, not a presence', () => {
  assert.equal(parse(account, { kind: 'premium', tier: 'silver' }).success, false)
  assert.equal(parse(account, { kind: 'premium', tier: 'gold' }).success, true)
  assert.equal(parse(account, { kind: 'basic', tier: 'silver' }).success, true)
})

test('validation accepts a body that satisfies its branch', () => {
  assert.equal(
    parse(shipment, { state: 'open', tags: ['bulk', 'fragile'] }).success,
    true
  )
  assert.equal(
    parse(shipment, {
      state: 'canceled',
      cancellationReason: 'x',
      tags: ['bulk', 'fragile']
    }).success,
    true
  )
})

test('a false property schema forbids the property outright', () => {
  const schema: Schema = {
    type: 'object',
    properties: { banned: false, kept: { type: 'string' } }
  }
  assert.equal(parse(schema, { kept: 'a' }).success, true)
  assert.equal(parse(schema, { kept: 'a', banned: 'b' }).success, false)
  const value = generate(schema, 'false-property')
  assert.equal('banned' in value, false)
  assert.equal(typeof value.kept, 'string')
})

test('a required name with no declared property must still be present', () => {
  const schema: Schema = { type: 'object', required: ['a'] }
  assert.equal(parse(schema, { a: 1 }).success, true)
  assert.equal(parse(schema, {}).success, false)
})

const doc = {
  openapi: '3.1.0',
  paths: {
    '/shipment': {
      post: {
        operationId: 'createShipment',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: shipment } }
        },
        responses: {
          '200': { description: 'ok' },
          '400': {
            description: 'invalid',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['errorCode'],
                  properties: { errorCode: { type: 'string' } }
                }
              }
            }
          }
        }
      }
    }
  }
}

async function post(body: unknown): Promise<Response> {
  const handle = createHandler(loadApi(doc), { seed: 'conditional' }).fetch
  return handle(
    new Request('http://mock/shipment', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' }
    })
  )
}

test('a conditional violation is a 400 on the declared error contract', async () => {
  for (const body of [
    { state: 'open', cancellationReason: 'x', tags: ['bulk', 'fragile'] },
    { state: 'canceled', tags: ['bulk', 'fragile'] }
  ]) {
    const response = await post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    const payload = (await response.json()) as Record<string, unknown>
    // Invariant 5: the operation declares a 400 schema, so the envelope is
    // that schema rather than the built-in one.
    assert.equal(typeof payload.errorCode, 'string')
  }
})

test('a conforming body still answers 200', async () => {
  const response = await post({ state: 'open', tags: ['bulk', 'fragile'] })
  assert.equal(response.status, 200)
})
