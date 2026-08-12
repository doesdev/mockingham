import { fnv1a } from '../generate/rng.ts'

/**
 * `hash(requestKey, ordinal)` rather than a random id.
 *
 * A random id would be the obvious choice and is wrong here: `requestId` is the
 * natural value to echo on a response header for correlation, and the moment it
 * does, a random id breaks the determinism invariant. Hashing request identity
 * plus an ordinal gives an id that is stable across processes and still distinct
 * across repeated identical calls.
 *
 * The ordinal MUST come from its own counter, not the chaos counter — the
 * failure stage increments that one per policy evaluation, and sharing it would
 * shift every subsequent chaos roll the moment logging was switched on. See the
 * phases 7-9 design §2.2.
 *
 * Two hashes, because one fnv1a is 32 bits and 8 hex characters collide often
 * enough to be annoying in a log search.
 */
export function requestIdFor(requestKey: string, ordinal: number): string {
  const head = fnv1a(`${requestKey}|${ordinal}`).toString(16).padStart(8, '0')
  const tail = fnv1a(`${requestKey}|${ordinal}|mockingham`).toString(16).padStart(8, '0')
  return `${head}${tail}`
}
