import type { Operation } from '../spec/types.ts'
import type { Store } from './store.ts'
import { targetKey } from './failure.ts'

/**
 * Exported because `index.ts` WRITES the key this module READS - the same
 * reasoning `overrideKey` records. Two independent spellings of one convention
 * drift silently, with both test suites green.
 */
export function variantKey(key: string): string {
  return `variant|${key}`
}

/**
 * The stored `set_variant` preference for an operation, or `undefined`.
 *
 * Precedence lives at the call site, not here: `Prefer: variant=` on the
 * request beats this, for the same reason `Prefer: status` beats a configured
 * status - a header is a statement about *this* call. Design section 5.5.
 *
 * `setVariant` only ever writes a string, but the Store is advertised as
 * shareable across processes, so anything else reads as no stored variant
 * rather than crashing the request.
 */
export async function readVariant(
  store: Store,
  operation: Operation
): Promise<string | undefined> {
  const raw = await store.get(variantKey(targetKey(operation)))
  return typeof raw === 'string' ? raw : undefined
}
