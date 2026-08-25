/**
 * The seeded virtual clock behind UUIDv7 generation.
 *
 * A v7 UUID's first 48 bits are a millisecond timestamp, which is the whole
 * point of the format and also the whole problem: reading a real clock inside
 * a generation path violates invariant 2 outright. So the timestamp comes from
 * a counter instead - starting at `seedTime`, advancing a fixed step per
 * generated value.
 *
 * ## Why this is an allocator rather than one shared counter
 *
 * It was a single mutable counter, drawn at generation time, and that broke
 * invariant 2 as amended by the refinements design §4.5 ("the same request
 * SEQUENCE produces byte-identical output"). Generation happens after
 * `readOverride`, `readVariant` and the fixture resolver have all awaited, and
 * a webhook emission generates its payload on a `setTimeout`. So the order in
 * which draws reached one shared counter was decided by wall-clock timing, not
 * by the request sequence. Observed, with an identical sequence and the same
 * seed, varying only how long the caller waited between two calls:
 *
 *     gap=0    post …7c00  get …7c01  hook …7c02
 *     gap=60   post …7c00  get …7c02  hook …7c01
 *
 * The `get` there is a caller-visible response body, not merely a webhook
 * payload. The random halves were byte-identical across both runs - they come
 * from the per-request seeded rng, which was never the problem.
 *
 * The fix is to reserve a block SYNCHRONOUSLY, at request entry and at
 * emission scheduling, and let generation draw from its own block whenever it
 * gets around to running. Reservation order is arrival order, which is what
 * "the request sequence" means; completion order stops mattering.
 *
 * This is the same shape as `requestOrdinals` and the webhook counter, both of
 * which were already drawn synchronously per request. The clock was the one
 * piece of generation state that was not, which is why it was the one that
 * broke.
 */
export interface Ticker {
  /** The timestamp for the next generated value, then advances one step. */
  next(): number
}

export interface VirtualClock {
  /**
   * Reserves a block of timestamps. MUST be called synchronously - at request
   * entry, or when an emission is scheduled - never at generation time, which
   * is the bug this exists to prevent.
   */
  allocate(): Ticker
  /** Back to `seedTime`, matching how `reset()` treats every other counter. */
  reset(): void
}

/**
 * 2025-01-01T00:00:00.000Z. A fixed epoch, deliberately **not** `Date.now()` -
 * a wall-clock default would make baked fixtures unstable across runs, which is
 * the exact failure `seedTime` exists to prevent.
 */
export const DEFAULT_SEED_TIME = Date.parse('2025-01-01T00:00:00.000Z')

/**
 * One millisecond. Fixed rather than a seeded jitter: a jitter would make
 * "sorts by generation order" probably true, and fixed makes it exactly true.
 */
export const SEED_TIME_STEP_MS = 1

/**
 * How many timestamps one allocation reserves.
 *
 * This is the ceiling on UUIDv7 values a single request or emission can
 * generate. Beyond it a block spills into its successor's range and **collides
 * with it immediately** - the spilling block's 65,537th value equals its
 * successor's first - so ordering and uniqueness both break, not just
 * ordering. Since §8.3 records that uniqueness across requests rests on the
 * clock rather than on entropy, that is worth stating exactly rather than
 * softening.
 *
 * Reachable only from an array with `minItems` above 65,536, which nothing
 * bounds today. 65,536 v7 values in one response body is far outside anything
 * a mock is for, and the alternative - asking a shared counter per value - is
 * precisely the async-ordering bug this design exists to prevent.
 */
export const TICKS_PER_ALLOCATION = 65_536

export function createVirtualClock(
  seedTime: number = DEFAULT_SEED_TIME
): VirtualClock {
  let allocations = 0
  return {
    allocate() {
      // Reserved here, synchronously, and read later. That split is the whole
      // mechanism: `base` is fixed by the order allocate() was CALLED, so it
      // cannot be changed by how long the caller waits or which request
      // finishes first.
      const base = seedTime + allocations * TICKS_PER_ALLOCATION
      allocations += 1
      let offset = 0
      return {
        next() {
          const value = base + offset
          offset += SEED_TIME_STEP_MS
          return value
        }
      }
    },
    reset() {
      allocations = 0
    }
  }
}
