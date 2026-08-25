/**
 * Asserts the published tarball carries what it should and nothing else.
 *
 * `package.json`'s `files` field is checked by `test/packaging.test.ts`, but
 * that reads the manifest - it cannot see what npm actually resolves the field
 * to. This runs the real pack and inspects the result, which is the only way
 * to catch a stray include, a new top-level directory, or an `.npmignore`
 * someone adds later.
 *
 * Run by CI and by `npm run check:package`.
 */
import { execFileSync, execSync } from 'node:child_process'

/** Everything npm includes on its own, regardless of `files`. */
const ALWAYS_INCLUDED = new Set(['package.json', 'README.md', 'LICENSE'])

interface PackResult {
  files: Array<{ path: string }>
}

const PACK_ARGS = ['pack', '--dry-run', '--json']

const options = {
  encoding: 'utf8',
  // npm writes its human-readable notices to stderr; only stdout is JSON.
  stdio: ['ignore', 'pipe', 'ignore']
} as const

// There is no file named `npm` on Windows. It is `npm.cmd`, which
// `execFileSync` neither resolves through PATHEXT nor spawns without a shell.
// npm sets `npm_execpath` to its own CLI entry point when running a script, so
// running that under the current Node binary avoids both problems. Direct
// invocation of this script has no such variable and goes through a shell,
// which resolves the name the way a terminal would.
const npmCli = process.env.npm_execpath
const output =
  npmCli === undefined
    ? execSync(['npm', ...PACK_ARGS].join(' '), options)
    : execFileSync(process.execPath, [npmCli, ...PACK_ARGS], options)

const [result] = JSON.parse(output) as PackResult[]
if (result === undefined) {
  console.error('mockingham: npm pack returned no result')
  process.exit(1)
}

const paths = result.files.map((file) => file.path).sort()
const unexpected = paths.filter(
  (path) => !path.startsWith('src/') && !ALWAYS_INCLUDED.has(path)
)

if (unexpected.length > 0) {
  console.error(
    'mockingham: the published tarball would carry files outside src/:\n' +
      unexpected.map((path) => `  ${path}`).join('\n') +
      '\n\nAdjust the `files` field in package.json, or add the path to ' +
      'ALWAYS_INCLUDED in this script if it genuinely belongs in the package.'
  )
  process.exit(1)
}

// A publish that ships nothing is the other way this can go wrong, and an
// empty `files` array would satisfy the check above.
const sourceFiles = paths.filter((path) => path.startsWith('src/'))
if (sourceFiles.length === 0) {
  console.error('mockingham: the tarball carries no source files at all')
  process.exit(1)
}

for (const required of ALWAYS_INCLUDED) {
  if (!paths.includes(required)) {
    console.error(`mockingham: the tarball is missing ${required}`)
    process.exit(1)
  }
}

console.log(
  `mockingham: tarball carries ${sourceFiles.length} source files, ` +
    `${[...ALWAYS_INCLUDED].sort().join(', ')}, and nothing else`
)
