import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * The `exports` map, asserted through real module resolution rather than by
 * reading package.json back to itself.
 *
 * Node lets a package import itself by name ONLY when it declares `exports`,
 * so a self-referencing import is a genuine end-to-end check of the map: if
 * `exports` were removed, the first test here stops resolving. The rest of the
 * suite cannot cover this — every other test reaches into `src/` by relative
 * path, which `exports` does not govern, and the docs harness rewrites
 * `from 'mockingham'` to a relative path before running a document.
 *
 * Deferred item 27.
 */

test('the package resolves by name, through its exports map', async () => {
  const entry = await import('mockingham')
  assert.equal(typeof entry.createMock, 'function')
  assert.equal(typeof entry.loadApi, 'function')
})

test('a deep import into src is not resolvable through the package name', async () => {
  // The whole point of the strict map: `src/` is an implementation detail, and
  // an internal path someone discovers today becomes a compatibility
  // obligation tomorrow.
  // Built rather than written literally: the specifier is meant NOT to
  // resolve, and a literal one is a type error before it is ever a runtime
  // assertion.
  const deep = ['mockingham', 'src', 'runtime', 'store.ts'].join('/')
  await assert.rejects(
    () => import(deep),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
      return true
    }
  )
})

test('package.json stays reachable, because tooling reads it', async () => {
  const manifest = await import('mockingham/package.json', { with: { type: 'json' } })
  assert.equal((manifest.default as { name: string }).name, 'mockingham')
})

test('the published file list carries src and nothing else', async () => {
  // There was no `files` field at all, so a publish shipped test/, docs/, and
  // every scratch file in the tree. npm always includes README and LICENSE on
  // its own, so neither needs listing here.
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as { files?: string[] }
  assert.deepEqual(manifest.files, ['src'])
})
