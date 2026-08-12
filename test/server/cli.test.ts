import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, startCli, USAGE } from '../../src/server/cli.ts'

const cliPath = fileURLToPath(new URL('../../src/server/cli.ts', import.meta.url))

const doc = (title: string) => JSON.stringify({
  openapi: '3.1.0',
  info: { title, version: '1.0.0' },
  paths: {
    '/ping': {
      get: {
        operationId: 'ping',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string', const: title } }, required: ['title'] } } }
          }
        }
      }
    }
  }
})

test('parseArgs reads a document path and defaults', () => {
  assert.deepEqual(parseArgs(['api.json']), {
    document: 'api.json', port: 0, seed: undefined, watch: false, help: false
  })
})

test('parseArgs reads every flag', () => {
  assert.deepEqual(parseArgs(['api.json', '--port', '4000', '--seed', 's', '--watch']), {
    document: 'api.json', port: 4000, seed: 's', watch: true, help: false
  })
})

test('parseArgs accepts --flag=value', () => {
  assert.equal(parseArgs(['api.json', '--port=4000']).port, 4000)
})

test('parseArgs recognizes help', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('parseArgs rejects a non-numeric port', () => {
  assert.throws(() => parseArgs(['api.json', '--port', 'soon']), /--port/)
})

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['api.json', '--colour']), /--colour/)
})

test('startCli refuses a YAML document with a useful message', async () => {
  await assert.rejects(
    startCli(['api.yaml'], { readFile: async () => '', log: () => {} }),
    /YAML/
  )
})

test('startCli refuses a missing document argument', async () => {
  await assert.rejects(startCli([], { log: () => {} }), /document/)
})

test('startCli still treats --help as nothing to serve', async () => {
  // Unchanged: startCli's contract is "serve a document or throw". The exit-0
  // behavior for a real `mockingham --help` invocation lives in the
  // `import.meta.main` block, which checks the flag before ever calling this
  // — see the next test, which drives the actual entry point.
  await assert.rejects(
    startCli(['--help'], { log: () => {} }),
    /nothing to serve/
  )
})

test('mockingham --help exits 0', async () => {
  // The real regression: `--help` used to reach startCli's throw, which made
  // the process exit 1 — wrong for a help flag, and enough to break a CI
  // smoke check that just runs `--help` and expects success.
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--help'], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })

  assert.equal(exitCode, 0)
})

test('mockingham with a missing document argument still exits non-zero', async () => {
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })

  assert.equal(exitCode, 1)
})

test('startCli serves the document over a real port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const lines: string[] = []
  const handle = await startCli([path, '--seed', 'cli'], { log: (line) => lines.push(line) })

  const response = await fetch(`${handle.url}/ping`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { title: 'first' })
  assert.ok(lines.some((line) => line.includes(handle.url)))
  assert.equal(handle.watching, false)

  await handle.close()
})

test('reload picks up an edited document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const handle = await startCli([path, '--watch'], { log: () => {} })
  assert.equal(handle.watching, true)

  await writeFile(path, doc('second'))
  await handle.reload()

  assert.deepEqual(await (await fetch(`${handle.url}/ping`)).json(), { title: 'second' })
  await handle.close()
})

test('a broken edit leaves the previous document serving', async () => {
  // Invariant 4's spirit: the mock keeps serving. A half-saved file must not
  // take the server down.
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-cli-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('first'))

  const errors: string[] = []
  const handle = await startCli([path, '--watch'], { log: (line) => errors.push(line) })

  await writeFile(path, '{ not json')
  await handle.reload()

  assert.deepEqual(await (await fetch(`${handle.url}/ping`)).json(), { title: 'first' })
  assert.ok(errors.some((line) => line.toLowerCase().includes('reload')))
  await handle.close()
})

test('USAGE names every flag', () => {
  for (const flag of ['--port', '--seed', '--watch', '--help']) {
    assert.ok(USAGE.includes(flag), `USAGE is missing ${flag}`)
  }
})
