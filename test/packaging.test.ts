import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/**
 * What the manifest PROMISES a consumer. What it DELIVERS is asserted by
 * `scripts/check-install.ts`, which packs, installs into an empty directory,
 * imports by name and runs the bin.
 *
 * That split is the lesson from 0.2.0. This file used to open with a
 * self-referencing `import('mockingham')`, on the reasoning that Node resolves
 * a package's own name through its `exports` map and so the import is a
 * genuine end-to-end check. It is a genuine check of the MAP, and it passed
 * for a package that could not be imported by anyone: self-reference resolves
 * into the working tree, where `.ts` entry points strip types happily, while
 * the same files under a consumer's `node_modules` throw
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. No test that runs inside this
 * repository can tell those two cases apart, so the check that matters had to
 * leave the repository, and did.
 *
 * Deferred item 27.
 */

const manifest = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as Record<string, unknown>

test('every advertised entry point is JavaScript, not TypeScript', async () => {
  // The 0.2.0 defect, stated as an assertion. Node's refusal to strip types
  // under node_modules is a documented restriction rather than a flag, so a
  // `.ts` entry point is unloadable on every install, on every Node version.
  const pkg = await manifest()
  const bin = pkg['bin'] as Record<string, string>
  const exports = pkg['exports'] as Record<string, Record<string, string>>

  assert.equal(pkg['main'], './dist/index.js')
  assert.equal(pkg['types'], './dist/index.d.ts')
  assert.equal(bin['mockingham'], './dist/server/cli.js')
  assert.equal(exports['.']?.['default'], './dist/index.js')
  assert.equal(exports['.']?.['types'], './dist/index.d.ts')
})

test('package.json stays reachable, because tooling reads it', async () => {
  const pkg = await manifest()
  const exports = pkg['exports'] as Record<string, unknown>
  assert.equal(exports['./package.json'], './package.json')
})

test('no subpath exposes the implementation tree', async () => {
  // `src` and `dist` both ship - `src` only so the declaration and source maps
  // resolve - but neither is addressable through the package name. An internal
  // path someone discovers today is a compatibility obligation tomorrow.
  const pkg = await manifest()
  const subpaths = Object.keys(pkg['exports'] as Record<string, unknown>)
  assert.deepEqual(subpaths, ['.', './package.json'])
})

test('the published file list carries dist, src and the changelog', async () => {
  // There was no `files` field at all once, so a publish shipped test/, docs/,
  // and every scratch file in the tree. npm always includes README and LICENSE
  // on its own, so neither needs listing here - but not a changelog, which is
  // why that one is listed explicitly.
  const pkg = await manifest()
  assert.deepEqual(pkg['files'], ['dist', 'src', 'CHANGELOG.md'])
})

test('packing builds first, so dist cannot go stale or missing', async () => {
  // Without this, `npm publish` from a tree that has never been built ships a
  // manifest pointing at files the tarball does not contain.
  const scripts = (await manifest())['scripts'] as Record<string, string>
  assert.equal(scripts['prepack'], 'npm run build')
  assert.equal(scripts['build'], 'tsc -p tsconfig.build.json')
})
