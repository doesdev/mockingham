import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixtureEntry, FixtureStore } from './store.ts'
import { createMemoryFixtureStore } from './store.ts'

export interface DiskStoreOptions {
  dir: string
  debounceMs?: number
  onWarn?: (message: string) => void
}

/**
 * An operation id reaches the filesystem as a file name. It comes from the
 * document's `operationId`, which is author-controlled, so it is checked rather
 * than trusted.
 */
function safeName(operationId: string): string {
  if (operationId.includes('/') || operationId.includes('\\') || operationId.includes('..')) {
    throw new Error(
      `mockingham: operation id ${JSON.stringify(operationId)} is not a safe file name`
    )
  }
  return `${operationId}.json`
}

export async function loadFixtures(
  dir: string,
  store: FixtureStore,
  onWarn?: (message: string) => void
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    // A missing fixture directory is the normal case. Anything else — a
    // permission problem, a path that is not a directory — would otherwise be
    // indistinguishable from "no fixtures", which an operator cannot diagnose.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      onWarn?.(`mockingham: could not read the fixture directory ${dir}; serving no fixtures`)
    }
    return
  }

  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const operationId = name.slice(0, -'.json'.length)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      // Invariant 4: a broken fixture file must not stop the mock from serving.
      onWarn?.(`mockingham: could not read fixture file ${name}; skipping it`)
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      onWarn?.(`mockingham: fixture file ${name} is not an object; skipping it`)
      continue
    }
    const byStatus = parsed as Record<string, Record<string, FixtureEntry>>
    for (const statusKey of Object.keys(byStatus).sort()) {
      const bucket = byStatus[statusKey]
      if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
        onWarn?.(`mockingham: fixture file ${name} has a non-object status bucket ${JSON.stringify(statusKey)}; skipping it`)
        continue
      }
      const status = Number(statusKey)
      if (!Number.isInteger(status)) {
        onWarn?.(`mockingham: fixture file ${name} has a non-numeric status ${JSON.stringify(statusKey)}; skipping it`)
        continue
      }
      for (const key of Object.keys(bucket).sort()) {
        store.set(operationId, status, key, bucket[key] as FixtureEntry)
      }
    }
  }
}

export async function writeFixtures(dir: string, store: FixtureStore): Promise<void> {
  const files = new Map<string, Record<string, Record<string, FixtureEntry>>>()
  for (const record of store.records()) {
    const file = safeName(record.operationId)
    const byStatus = files.get(file) ?? {}
    const bucket = byStatus[String(record.status)] ?? {}
    bucket[record.key] = record.entry
    byStatus[String(record.status)] = bucket
    files.set(file, byStatus)
  }

  await mkdir(dir, { recursive: true })
  for (const [file, content] of [...files.entries()].sort()) {
    // Temp file plus rename: a reader never sees a half-written file, and a
    // crash mid-write leaves the previous version intact.
    const temp = join(dir, `.${file}.tmp`)
    await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`)
    await rename(temp, join(dir, file))
  }
}

export async function createDiskFixtureStore(
  options: DiskStoreOptions
): Promise<FixtureStore & { flush(): Promise<void> }> {
  const memory = createMemoryFixtureStore()
  await loadFixtures(options.dir, memory, options.onWarn)

  const debounceMs = options.debounceMs ?? 250
  let timer: ReturnType<typeof setTimeout> | undefined

  // Serialized rather than concurrent. writeFixtures always writes the full
  // current store, so chaining makes last-write-wins correct by construction —
  // two overlapping writes could otherwise land their renames out of order and
  // leave stale content behind a resolved flush().
  let queue: Promise<void> = Promise.resolve()

  const write = (): Promise<void> => {
    timer = undefined
    queue = queue.then(() => writeFixtures(options.dir, memory))
    return queue
  }

  return {
    get: memory.get,
    records: memory.records,
    clear: memory.clear,

    set(operationId, status, key, entry) {
      memory.set(operationId, status, key, entry)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void write(), debounceMs)
    },

    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      return write()
    }
  }
}
