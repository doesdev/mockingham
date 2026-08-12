import type { Schema } from '../spec/types.ts'
import type { Ctx, Resolvers } from '../runtime/types.ts'

export type ResolverHit = { hit: true; value: unknown } | { hit: false }

export interface ResolverLookup {
  resolve(
    schema: Schema,
    propertyName: string | undefined,
    schemaName: string | undefined,
    ctx: unknown
  ): ResolverHit
}

const MISS: ResolverHit = { hit: false }

/**
 * Converts a glob to an anchored RegExp. Every regex metacharacter is escaped
 * first, so a literal '.' in a property name stays literal; only '*' survives
 * as a wildcard.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
}

export function compileResolvers(resolvers: Resolvers = {}): ResolverLookup {
  const byName = (resolvers.byName ?? []).map(([pattern, fn]) => ({
    test: typeof pattern === 'string' ? globToRegExp(pattern) : pattern,
    fn
  }))

  return {
    resolve(schema, propertyName, schemaName, ctx) {
      const request = ctx as Ctx

      if (schemaName !== undefined && propertyName !== undefined) {
        const fn = resolvers.bySchema?.[schemaName]?.[propertyName]
        if (fn) return { hit: true, value: fn(request) }
      }

      if (propertyName !== undefined) {
        for (const entry of byName) {
          // A RegExp with the global flag carries lastIndex between calls, so
          // test it from a known state rather than trusting the caller's flags.
          entry.test.lastIndex = 0
          if (entry.test.test(propertyName)) {
            return { hit: true, value: entry.fn(request) }
          }
        }
      }

      if (schema.format !== undefined) {
        const fn = resolvers.byFormat?.[schema.format]
        if (fn) return { hit: true, value: fn(request) }
      }

      return MISS
    }
  }
}
