import type { Operation } from './types.ts'

export interface RouteMatch {
  operation: Operation
  params: Record<string, string>
}

export interface Router {
  match(method: string, path: string): RouteMatch | undefined
  allowedMethods(path: string): string[]
  /**
   * The templated path for a resolved path, matched by segments alone
   * (method ignored). Used for a 405's log record: the method is wrong but the
   * path is known, and every method sharing an OpenAPI path key shares the same
   * template string, so which matching route answers is immaterial.
   */
  templateFor(path: string): string | undefined
}

interface Segment {
  value: string
  dynamic: boolean
}

interface Route {
  operation: Operation
  segments: Segment[]
  score: number[]
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

function compile(operation: Operation): Route {
  const segments = split(operation.path).map((raw) => {
    const matched = /^\{(.+)\}$/.exec(raw)
    return matched
      ? { value: matched[1] as string, dynamic: true }
      : { value: raw, dynamic: false }
  })
  return { operation, segments, score: segments.map((s) => (s.dynamic ? 1 : 0)) }
}

function compareScore(a: Route, b: Route): number {
  const length = Math.max(a.score.length, b.score.length)
  for (let i = 0; i < length; i++) {
    const left = a.score[i] ?? -1
    const right = b.score[i] ?? -1
    if (left !== right) return left - right
  }
  return 0
}

/**
 * `decodeURIComponent` throws a `URIError` on a malformed escape such as `%`
 * or `%zz`. Path segments come straight off the wire, so a client could
 * otherwise crash route matching with `GET /pets/%`. An undecodable segment is
 * treated as a non-match, which surfaces as a 404 rather than an exception.
 */
function decodeSegment(part: string): string | undefined {
  try {
    return decodeURIComponent(part)
  } catch {
    return undefined
  }
}

function matchSegments(
  route: Route,
  parts: string[]
): Record<string, string> | undefined {
  if (route.segments.length !== parts.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i] as Segment
    const part = parts[i] as string
    if (segment.dynamic) {
      const decoded = decodeSegment(part)
      if (decoded === undefined) return undefined
      params[segment.value] = decoded
    } else if (segment.value !== part) return undefined
  }
  return params
}

export function createRouter(operations: Operation[]): Router {
  const routes = operations.map(compile).sort(compareScore)

  return {
    match(method, path) {
      const wanted = method.toUpperCase()
      const parts = split(path)
      for (const route of routes) {
        if (route.operation.method.toUpperCase() !== wanted) continue
        const params = matchSegments(route, parts)
        if (params !== undefined) return { operation: route.operation, params }
      }
      return undefined
    },

    allowedMethods(path) {
      const parts = split(path)
      const found: string[] = []
      for (const route of routes) {
        if (matchSegments(route, parts) === undefined) continue
        const method = route.operation.method.toUpperCase()
        if (!found.includes(method)) found.push(method)
      }
      return found
    },

    templateFor(path) {
      const parts = split(path)
      for (const route of routes) {
        if (matchSegments(route, parts) !== undefined) return route.operation.path
      }
      return undefined
    }
  }
}
