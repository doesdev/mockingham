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
  } catch {
    // No fixture directory is the common case, not an error.
    return
  }

  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const operationId = name.slice(0, -'.json'.length)
    let parsed: Record<string, Record<string, FixtureEntry>>
    try {
      parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      // Invariant 4: a broken fixture file must not stop the mock from serving.
      onWarn?.(`mockingham: could not read fixture file ${name}; skipping it`)
      continue
    }
    for (const status of Object.keys(parsed).sort()) {
      const bucket = parsed[status] ?? {}
      for (const key of Object.keys(bucket).sort()) {
        store.set(operationId, Number(status), key, bucket[key] as FixtureEntry)
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
  let pending: Promise<void> | undefined

  const write = async (): Promise<void> => {
    timer = undefined
    pending = writeFixtures(options.dir, memory)
    await pending
    pending = undefined
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

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await write()
      if (pending) await pending
    }
  }
}
