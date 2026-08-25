import { fnv1a } from '../generate/rng.ts'
import type { Operation } from '../spec/types.ts'

export interface KeyInput {
  method: string
  /** The templated path, not the concrete one. */
  path: string
  params: Record<string, string>
  /** Configured query and header contributors, already selected by the caller. */
  contributors?: Record<string, string>
}

/**
 * A filesystem-safe, stable identifier for an operation. `operationId` when the
 * document supplies one; otherwise method and path, which is unique because the
 * router already rejects duplicate method-path pairs.
 */
export function operationSlug(operation: Operation): string {
  if (operation.operationId) return operation.operationId
  const path = operation.path
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${operation.method}_${path}`
}

function pairs(values: Record<string, string>): Array<[string, string]> {
  return Object.keys(values)
    .sort()
    .map((name) => [name, values[name] as string])
}

/**
 * The fixture key is the request identity WITHOUT the root seed - design
 * section 2.1. Including the seed would mean a run started with a different
 * `seed` misses every fixture on disk, which turns varying the seed into
 * silently abandoning reviewed data.
 *
 * Eight hex characters, matching the master spec's storage example. Thirty-two
 * bits is narrow, but the key space is scoped per operation and per status, and
 * the store is a reviewed artifact where a collision shows up in the diff.
 */
export function fixtureKey(input: KeyInput): string {
  const canonical = JSON.stringify([
    input.method.toLowerCase(),
    input.path,
    pairs(input.params),
    pairs(input.contributors ?? {})
  ])
  return fnv1a(canonical).toString(16).padStart(8, '0')
}
