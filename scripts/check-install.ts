/**
 * Installs the package the way a consumer does, then imports it and runs its
 * bin.
 *
 * `check-package.ts` inspects what the tarball CARRIES. This asserts the
 * tarball WORKS, which is a different question and the one that was missed:
 * 0.2.0 shipped `.ts` entry points, and Node refuses to strip types for any
 * file under `node_modules`, so both advertised entry points - the library
 * import and the bin - threw `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on
 * every install. Nothing inside this repository could see it: every test
 * reaches into `src/` by relative path, and even a self-referencing
 * `import 'mockingham'` resolves to the working tree rather than to an
 * installed copy, so it strips types happily and passes.
 *
 * The only check that can catch this class is one that leaves the repository.
 *
 * Run by CI and by `npm run check:install`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = new URL('..', import.meta.url).pathname
const scratch = mkdtempSync(join(tmpdir(), 'mockingham-install-'))

const run = (command: string, args: string[], cwd: string): string =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })

// npm is `npm.cmd` on Windows, which execFileSync cannot spawn directly. npm
// sets `npm_execpath` to its own CLI entry when running a script; running that
// under the current Node binary sidesteps the whole problem. Matches the
// approach in check-package.ts.
const npmCli = process.env['npm_execpath']
const npm = (args: string[], cwd: string): string =>
  npmCli === undefined
    ? run('npm', args, cwd)
    : run(process.execPath, [npmCli, ...args], cwd)

let failed = false
const fail = (message: string, detail?: unknown): void => {
  failed = true
  console.error(`mockingham: ${message}`)
  if (detail !== undefined) console.error(String(detail))
}

try {
  // A real pack, not a dry run - this one has to produce a file to install,
  // and it runs `prepack`, so the build is exercised too.
  npm(['pack', '--pack-destination', scratch], repo)

  const tarball = readdirSync(scratch).find((name) => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error('npm pack produced no tarball')

  // The consumer directory needs its own manifest before install, or npm
  // walks up and installs into the scratch root instead.
  const consumer = join(scratch, 'consumer')
  mkdirSync(consumer, { recursive: true })
  writeFileSync(
    join(consumer, 'package.json'),
    '{"name":"consumer","private":true,"type":"module"}'
  )

  npm(['install', '--no-audit', '--no-fund', join(scratch, tarball)], consumer)

  // 1. The library entry point, imported by package name exactly as the README
  //    tells a consumer to.
  const probe = [
    "const m = await import('mockingham');",
    "if (typeof m.createMock !== 'function') throw new Error('createMock missing');",
    "if (typeof m.loadApi !== 'function') throw new Error('loadApi missing');",
    "const p = await import('mockingham/package.json', { with: { type: 'json' } });",
    "if (p.default.name !== 'mockingham') throw new Error('package.json subpath broken');",
    "console.log('ok');"
  ].join('\n')
  try {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', probe],
      { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    if (!out.includes('ok')) fail('the installed package imported but probed wrong', out)
  } catch (error) {
    fail(
      "`import 'mockingham'` fails from an installed copy",
      (error as { stderr?: string }).stderr ?? error
    )
  }

  // 2. The bin, run from the installed copy's .bin shim.
  try {
    const help = execFileSync(
      process.execPath,
      [join(consumer, 'node_modules', '.bin', 'mockingham'), '--help'],
      { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    if (!help.includes('mockingham')) {
      fail('the bin ran but printed no usage', help)
    }
  } catch (error) {
    fail(
      'the bin fails from an installed copy',
      (error as { stderr?: string }).stderr ?? error
    )
  }

  // 3. A deep import into the implementation stays unreachable. Asserted here
  //    rather than in the suite because only an installed copy resolves the
  //    package name through `exports` for real.
  const deep = ['mockingham', 'dist', 'runtime', 'store.js'].join('/')
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import('${deep}')`],
      { cwd: consumer, stdio: 'ignore' }
    )
    fail(`a deep import into the implementation resolved: ${deep}`)
  } catch {
    // Expected: ERR_PACKAGE_PATH_NOT_EXPORTED.
  }

  if (!failed) {
    console.log(
      'mockingham: the installed package imports by name, its bin runs, and ' +
        'deep imports stay unexported'
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failed) process.exit(1)
