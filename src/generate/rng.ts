export interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(): boolean
}

export function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * fnv1a over raw bytes. The idempotency fingerprint hashes the request body as
 * it arrived rather than a re-serialization of the parsed value: re-serializing
 * depends on key insertion order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` would
 * differ anyway - but only by accident, and a future canonicalization would
 * silently change which requests conflict. Hashing bytes makes the rule
 * explicit: byte-identical bodies replay, anything else conflicts.
 */
export function fnv1aBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] as number
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function createRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? fnv1a(seed) : seed) >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => {
      // The signature promises a T. Returning `items[0]` of an empty array
      // would hand back `undefined` wearing a T's type, which surfaces far
      // from the cause. Fail loudly at the call site instead.
      if (items.length === 0) {
        throw new Error('mockingham: cannot pick from an empty array')
      }
      return items[Math.floor(next() * items.length)] as T
    },
    bool: () => next() < 0.5
  }
}
