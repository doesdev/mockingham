/**
 * A stable string identity for a JSON value, used to decide whether two array
 * members are the same member for `uniqueItems`.
 *
 * Object keys are SORTED, so `{"a":1,"b":2}` and `{"b":2,"a":1}` compare equal
 * - which is what JSON Schema means by equality, and what a plain
 * `JSON.stringify` would get wrong for an incoming request whose keys arrived
 * in a different order. Sorting is also the only ordering involved anywhere in
 * this function, so the result is a pure function of the value and identical
 * across processes (invariant 2).
 *
 * One derivation, shared by generation (`src/generate/generate.ts` draws
 * without replacement) and validation (`src/schema/compile.ts` rejects a
 * repeat). Two would eventually disagree about which values count as the same
 * - exactly the drift invariant 1 exists to prevent.
 */
export function canonicalKey(value: unknown): string {
  if (value === undefined) return 'u'
  if (value === null) return 'n'
  if (Array.isArray(value)) {
    return `a[${value.map((item) => canonicalKey(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map(([name, member]) => `${JSON.stringify(name)}:${canonicalKey(member)}`)
    return `o{${entries.join(',')}}`
  }
  // A string is tagged so `"1"` and `1` never collide.
  return `${typeof value}:${String(value)}`
}
