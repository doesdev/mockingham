import type { Operation } from '../spec/types.ts'

export interface TargetMatcher {
  target: string
  matches(operation: Operation): boolean
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Compiles one of the four target forms into an operation predicate:
 *
 *   'getUserById'        an operationId
 *   'GET /users/{id}'    method plus the path template as written in the document
 *   '* /users/{id}'      any method
 *   'GET /orders/*'      '*' matches one segment, '**' matches the rest
 *
 * Path matching is against the template, not against a concrete request path -
 * `{id}` is a literal segment here, so '/users/{id}' targets the operation and
 * '/users/42' targets nothing.
 */
export function compileTarget(target: string): TargetMatcher {
  const trimmed = target.trim()
  const space = trimmed.indexOf(' ')

  if (space === -1) {
    if (trimmed.startsWith('/')) {
      throw new Error(
        `mockingham: target "${target}" looks like a path but has no method. ` +
          'Write "GET /users/{id}", or "* /users/{id}" to match any method.'
      )
    }
    return {
      target: trimmed,
      matches: (operation) => operation.operationId === trimmed
    }
  }

  const method = trimmed.slice(0, space).toUpperCase()
  const pattern = split(trimmed.slice(space + 1).trim())

  return {
    target: trimmed,
    matches(operation) {
      if (method !== '*' && operation.method.toUpperCase() !== method) return false
      const parts = split(operation.path)
      for (let i = 0; i < pattern.length; i++) {
        // '**' consumes whatever is left, including nothing at all.
        if (pattern[i] === '**') return true
        if (i >= parts.length) return false
        if (pattern[i] !== '*' && pattern[i] !== parts[i]) return false
      }
      return pattern.length === parts.length
    }
  }
}

/**
 * Resolves a target against a document's operations. A target matching nothing
 * is a configuration error rather than an empty result - it means an override,
 * failure policy, or control-plane call would silently never fire.
 */
export function resolveTarget(
  target: string,
  operations: Operation[]
): Operation[] {
  const matcher = compileTarget(target)
  const found = operations.filter((operation) => matcher.matches(operation))
  if (found.length === 0) {
    throw new Error(
      `mockingham: target "${target}" matches no operation in the document. ` +
        'Check the method, the path template exactly as written in the ' +
        'document, or the operationId.'
    )
  }
  return found
}
