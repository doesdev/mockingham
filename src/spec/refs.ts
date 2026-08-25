import type { Schema } from './types.ts'

export interface ResolvedDocument {
  document: Record<string, unknown>
  schemaNames: Map<Schema, string>
}

function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function resolveDocument(
  doc: Record<string, unknown>
): ResolvedDocument {
  const byNode = new Map<unknown, unknown>()
  const resolving = new Set<string>()

  function lookup(pointer: string): unknown {
    if (!pointer.startsWith('#/')) {
      throw new Error(
        `mockingham: only internal $ref is supported, got "${pointer}". ` +
          'Bundle external references before passing the document in.'
      )
    }
    let node: unknown = doc
    for (const raw of pointer.slice(2).split('/')) {
      if (node === null || typeof node !== 'object') {
        throw new Error(`mockingham: $ref "${pointer}" could not be resolved`)
      }
      node = (node as Record<string, unknown>)[decodeToken(raw)]
      if (node === undefined) {
        throw new Error(`mockingham: $ref "${pointer}" could not be resolved`)
      }
    }
    return node
  }

  function walk(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node
    if (byNode.has(node)) return byNode.get(node)

    if (Array.isArray(node)) {
      const out: unknown[] = []
      byNode.set(node, out)
      for (const item of node) out.push(walk(item))
      return out
    }

    const record = node as Record<string, unknown>
    const ref = record['$ref']
    if (typeof ref === 'string') {
      const target = lookup(ref)
      // A target already in byNode is a real schema, mid-construction. Return
      // its live object so the cycle forms - however many alias hops away it is.
      // This check must precede the `resolving` guard, or an alias chain like
      // `A -> B` where B recurses back through A is rejected as circular.
      if (byNode.has(target)) return byNode.get(target)
      if (resolving.has(ref)) {
        throw new Error(
          `mockingham: circular $ref chain at "${ref}" - a reference resolves ` +
            'only to further references, with no schema between them.'
        )
      }
      resolving.add(ref)
      const resolved = walk(target)
      resolving.delete(ref)
      return resolved
    }

    const out: Record<string, unknown> = {}
    // register before recursing so a $ref back to this node returns this live object
    byNode.set(node, out)
    for (const [key, value] of Object.entries(record)) out[key] = walk(value)
    return out
  }

  const document = walk(doc) as Record<string, unknown>
  const schemaNames = new Map<Schema, string>()

  const components = document['components']
  if (components !== null && typeof components === 'object') {
    const schemas = (components as Record<string, unknown>)['schemas']
    if (schemas !== null && typeof schemas === 'object') {
      for (const [name, schema] of Object.entries(
        schemas as Record<string, unknown>
      )) {
        if (schema === null || typeof schema !== 'object') continue
        // An alias (`A: { $ref: '.../B' }`) resolves to the very same object as
        // its target, so both names would map to one schema. First declared
        // name wins, which keeps the table stable regardless of read order.
        if (!schemaNames.has(schema as Schema)) {
          schemaNames.set(schema as Schema, name)
        }
      }
    }
  }

  return { document, schemaNames }
}
