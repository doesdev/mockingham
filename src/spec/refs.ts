function decodeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function resolveDocument(
  doc: Record<string, unknown>
): Record<string, unknown> {
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
      if (resolving.has(ref)) {
        throw new Error(
          `mockingham: circular $ref chain at "${ref}" — a reference resolves ` +
            'only to further references, with no schema between them.'
        )
      }
      resolving.add(ref)
      const resolved = walk(lookup(ref))
      resolving.delete(ref)
      return resolved
    }

    const out: Record<string, unknown> = {}
    byNode.set(node, out)
    for (const [key, value] of Object.entries(record)) out[key] = walk(value)
    return out
  }

  return walk(doc) as Record<string, unknown>
}
