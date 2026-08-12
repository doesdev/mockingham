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
  /**
   * The header-name path. Separate from `resolve` because header names are
   * case-insensitive by RFC 9110 while schema property names are not: a user
   * writing byName: [['X-Request-Id', ...]] must match the lowercased header
   * this is called with, but a bySchema/byName property lookup must keep
   * matching exactly.
   */
  resolveHeader(name: string, ctx: unknown): ResolverHit
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

/** The same pattern, made case-insensitive, for the header path only. */
function ignoringCase(pattern: RegExp): RegExp {
  if (pattern.flags.includes('i')) return pattern
  return new RegExp(pattern.source, `${pattern.flags}i`)
}

export function compileResolvers(resolvers: Resolvers = {}): ResolverLookup {
  const byName = (resolvers.byName ?? []).map(([pattern, fn]) => {
    const test = typeof pattern === 'string' ? globToRegExp(pattern) : pattern
    return { test, headerTest: ignoringCase(test), fn }
  })

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
    },

    resolveHeader(name, ctx) {
      // Only byName participates: bySchema addresses a component's properties
      // and byFormat a schema's format, neither of which a header name has.
      for (const entry of byName) {
        entry.headerTest.lastIndex = 0
        if (entry.headerTest.test(name)) {
          return { hit: true, value: entry.fn(ctx as Ctx) }
        }
      }
      return MISS
    }
  }
}
