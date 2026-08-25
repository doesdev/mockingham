/**
 * The seeded virtual clock behind UUIDv7 generation.
 *
 * A v7 UUID's first 48 bits are a millisecond timestamp, which is the whole
 * point of the format and also the whole problem: reading a real clock inside
 * a generation path violates invariant 2 outright. So the timestamp comes from
 * a counter instead — per-mock, starting at `seedTime`, advancing a fixed step
 * per generated value. Monotonic within a run, identical across runs on the
 * same seed, which is what makes "ids sort by generation order" a property the
 * mock actually has rather than one it usually has.
 */
export interface VirtualClock {
  /** The timestamp for the next generated value, then advances one step. */
  next(): number
  /** Back to `seedTime`, matching how `reset()` treats every other counter. */
  reset(): void
}

/**
 * 2025-01-01T00:00:00.000Z. A fixed epoch, deliberately **not** `Date.now()` —
 * a wall-clock default would make baked fixtures unstable across runs, which is
 * the exact failure `seedTime` exists to prevent.
 */
export const DEFAULT_SEED_TIME = Date.parse('2025-01-01T00:00:00.000Z')

/**
 * One millisecond. Fixed rather than a seeded jitter: a jitter would make
 * "sorts by generation order" probably true, and fixed makes it exactly true.
 */
export const SEED_TIME_STEP_MS = 1

export function createVirtualClock(
  seedTime: number = DEFAULT_SEED_TIME
): VirtualClock {
  let current = seedTime
  return {
    next() {
      const value = current
      current += SEED_TIME_STEP_MS
      return value
    },
    reset() {
      current = seedTime
    }
  }
}
