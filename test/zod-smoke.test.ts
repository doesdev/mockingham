import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'

test('zod parses and infers under native type stripping', () => {
  const Pet = z.object({
    id: z.number().int(),
    name: z.string().min(1),
    email: z.email().optional()
  })

  type Pet = z.infer<typeof Pet>

  const parsed: Pet = Pet.parse({ id: 1, name: 'marsh' })
  assert.equal(parsed.id, 1)
  assert.equal(parsed.name, 'marsh')

  const bad = Pet.safeParse({ id: 'nope', name: '' })
  assert.equal(bad.success, false)
})

test('zod converts a schema to JSON Schema', () => {
  const schema = z.object({ name: z.string() })
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  assert.equal(json['type'], 'object')
})
