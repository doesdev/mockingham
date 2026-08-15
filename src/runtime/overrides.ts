import type { Operation } from '../spec/types.ts'
import type { StatusConfig } from './config.ts'
import type { Store } from './store.ts'
import type { OverrideNode } from './types.ts'
import { targetKey } from './failure.ts'

/**
 * `OperationConfig` minus `respond` and `emits`. One is a function that cannot
 * cross a JSON boundary; the other fires webhooks and belongs with the emission
 * lifecycle rather than with "what does this endpoint return right now."
 * Design section 2.
 */
export type RuntimeOverride = { status?: number } & { [status: number]: StatusConfig }

/**
 * Exported because `index.ts` WRITES the key this module READS. Two independent
 * spellings of one convention drift silently, with both test suites green — the
 * same reasoning `failure.ts` records for its own key builders.
 */
export function overrideKey(key: string): string {
  return `override|${key}`
}

/**
 * A runtime override must be JSON data. A function or a Date would survive the
 * in-process Store and change shape through an injected external one: the same
 * code, two deployments, silently different behavior. Refusing it at the door
 * is also what keeps `Mock.override()` and the `set_override` tool the same
 * surface in fact rather than in name. Design amendment 2.2.
 */
export function assertSerializable(
  value: unknown,
  path = 'value',
  seen = new Set<object>()
): void {
  if (value === null || value === undefined) return

  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new Error(
      `mockingham: override ${path} is a ${type}, which cannot survive a Store ` +
        'that serializes. Runtime overrides must be JSON data — use the ' +
        '`operations` config for anything that needs a function.'
    )
  }

  const object = value as object
  if (seen.has(object)) {
    throw new Error(
      `mockingham: override ${path} contains a cycle. Runtime overrides must be ` +
        'JSON data.'
    )
  }
  seen.add(object)

  if (Array.isArray(value)) {
    // Object keys holding `undefined` are dropped by `JSON.stringify`, which
    // preserves "absent"; array elements holding `undefined` become `null`,
    // which changes the value. Reject it.
    value.forEach((item, index) => {
      if (item === undefined) {
        throw new Error(
          `mockingham: override ${path}[${index}] is undefined. JSON serialization ` +
            'converts array holes to null, changing the value. Use null instead if ' +
            'that is what you intend.'
        )
      }
      assertSerializable(item, `${path}[${index}]`, seen)
    })
    seen.delete(object)
    return
  }

  const proto = Object.getPrototypeOf(object) as unknown
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `mockingham: override ${path} is a ${object.constructor?.name ?? 'non-plain object'}, ` +
        'which cannot survive a Store that serializes. Runtime overrides must ' +
        'be JSON data.'
    )
  }

  for (const [key, nested] of Object.entries(object as Record<string, unknown>)) {
    assertSerializable(nested, `${path}.${key}`, seen)
  }
  seen.delete(object)
}

const STATUS_KEY = /^[0-9]+$/

/** The only keys `overrideAsResolved` ever reads off a status entry. */
const STATUS_ENTRY_KEYS = new Set(['body', 'headers'])

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * `overrideAsResolved` only ever reads `value.status` and `value[forStatus]`
 * for a numeric `forStatus` — an own key that is neither `"status"` nor a run
 * of digits can never be read back, so accepting it would silently do
 * nothing. `resolveTarget` already treats a target matching no operation as a
 * configuration error rather than an empty result; a status key that can
 * never match is the same error one level down, and over MCP the caller would
 * otherwise get a success response either way. Design amendment 2.2.
 *
 * Two further checks live here for the same reason: `overrideAsResolved`
 * reads `value[forStatus].body` and `.headers` and nothing else, so a
 * misspelled key inside a status entry (`{ 200: { bdy: {...} } }`) is
 * accepted and silently inert. And status SELECTION compares
 * `runtime.status` with `===` against a number, so a string status
 * (`{ status: "404" }`) can never match and is just as silently inert. Both
 * are likelier mistakes than a bad top-level key, and both deserve the same
 * "this would never be read back" refusal rather than a passing test that
 * proves nothing.
 */
export function assertValidOverrideKeys(value: RuntimeOverride): void {
  const record = value as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (key === 'status') {
      const status = record.status
      if (typeof status !== 'number') {
        throw new Error(
          `mockingham: override "status" is a ${typeName(status)}, not a ` +
            'number. Status selection compares it with ===, so anything ' +
            'else can never match and would silently do nothing.'
        )
      }
      continue
    }

    if (!STATUS_KEY.test(key)) {
      throw new Error(
        `mockingham: override key "${key}" is not a status. An override key ` +
          'must be "status" or a numeric status code such as 200 — anything ' +
          'else can never be read back and would silently do nothing.'
      )
    }

    const entry = record[key]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `mockingham: override ${key} is a ${typeName(entry)}, not an object. ` +
          'A status entry must be an object with "body" and/or "headers" ' +
          'keys.'
      )
    }
    for (const innerKey of Object.keys(entry as Record<string, unknown>)) {
      if (!STATUS_ENTRY_KEYS.has(innerKey)) {
        throw new Error(
          `mockingham: override ${key}.${innerKey} is not "body" or ` +
            '"headers". A misspelled key here can never be read back and ' +
            'would silently do nothing.'
        )
      }
    }
  }
}

/**
 * The same shape `resolveConfigs` returns, so the handler composes a runtime
 * override with a config one without either side learning a new type.
 */
export interface ResolvedOverride {
  status?: number
  bodies(forStatus: number): OverrideNode[]
  headers(forStatus: number): Record<string, OverrideNode>
}

/**
 * Shared, and compared by IDENTITY in the handler to decide whether an override
 * contributed to the response — which is what the `x-mock-override` debug
 * header reports. A fresh empty object per request would work for composition
 * and break that check.
 */
export const EMPTY_OVERRIDE: ResolvedOverride = {
  status: undefined,
  bodies: () => [],
  headers: () => ({})
}

export function overrideAsResolved(value: RuntimeOverride): ResolvedOverride {
  return {
    status: value.status,
    bodies(forStatus) {
      const scoped = value[forStatus]
      return scoped?.body === undefined ? [] : [scoped.body]
    },
    headers(forStatus) {
      return value[forStatus]?.headers ?? {}
    }
  }
}

export async function readOverride(
  store: Store,
  operation: Operation
): Promise<ResolvedOverride> {
  const raw = await store.get(overrideKey(targetKey(operation)))
  // `override()` only ever writes a plain object here, but the Store is
  // advertised as shareable across processes — an older version, or another
  // process writing a different shape entirely, is a real possibility this
  // read must survive rather than crash on. Anything that is not a non-null,
  // non-array object reads as no override.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_OVERRIDE
  return overrideAsResolved(raw as RuntimeOverride)
}
