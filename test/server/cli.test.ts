import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseArgs,
  startCli,
  USAGE,
  resolveBakeTarget,
  resolveBakeModel,
  startBake,
  BAKE_USAGE
} from '../../src/server/cli.ts'
import { createMemoryFixtureStore } from '../../src/fixtures/store.ts'

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

test('mockingham with an unknown flag exits 1 with a clean message, not a stack trace', async () => {
  // Regression from the --help fix: parseArgs used to be called outside the
  // entry point's try, so a bad argument threw during top-level module
  // evaluation instead of being caught — a raw stack trace on stderr instead
  // of the same one clean line every other CLI misuse gets.
  const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, '--bogus'], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ exitCode: code, stderr }))
    }
  )

  assert.equal(exitCode, 1)
  assert.ok(stderr.includes('unknown option --bogus'))
  // A stack trace names the module job that ran the throwing code; a clean
  // console.error(...) message never does.
  assert.ok(!stderr.includes('ModuleJob'))
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

// --- bake ---------------------------------------------------------------

function reply(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

/** A store whose flush() is counted, so a test can prove it was actually called. */
function trackedMemoryStore() {
  const memory = createMemoryFixtureStore()
  let flushCalls = 0
  return {
    store: {
      get: memory.get,
      set: memory.set,
      records: memory.records,
      clear: memory.clear,
      async flush() {
        flushCalls += 1
      }
    },
    flushCalls: () => flushCalls
  }
}

test('resolveBakeTarget resolves the base url from the environment with an ollama default', () => {
  assert.equal(resolveBakeTarget({}, {}), 'http://localhost:11434/v1')
  assert.equal(
    resolveBakeTarget({}, { OPENAI_BASE_URL: 'http://elsewhere/v1' }),
    'http://elsewhere/v1'
  )
  assert.equal(
    resolveBakeTarget({}, { MOCKINGHAM_LLM_BASE_URL: 'http://wins/v1', OPENAI_BASE_URL: 'http://loses/v1' }),
    'http://wins/v1'
  )
  assert.equal(
    resolveBakeTarget({ baseUrl: 'http://flag/v1' }, { MOCKINGHAM_LLM_BASE_URL: 'http://env/v1' }),
    'http://flag/v1'
  )
})

test('resolveBakeModel resolves the model from the environment, flag winning over both', () => {
  assert.equal(resolveBakeModel({}, { OPENAI_MODEL: 'from-openai' }), 'from-openai')
  assert.equal(
    resolveBakeModel({}, { MOCKINGHAM_LLM_MODEL: 'wins', OPENAI_MODEL: 'loses' }),
    'wins'
  )
  assert.equal(
    resolveBakeModel({ model: 'flag-wins' }, { MOCKINGHAM_LLM_MODEL: 'env-loses' }),
    'flag-wins'
  )
})

test('resolveBakeModel fails clearly when no model is configured anywhere', () => {
  assert.throws(() => resolveBakeModel({}, {}), /--model/)
  assert.throws(() => resolveBakeModel({}, {}), /MOCKINGHAM_LLM_MODEL/)
  assert.throws(() => resolveBakeModel({}, {}), /OPENAI_MODEL/)
})

test('startBake fails clearly when no model is configured, before ever calling the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-bake-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('t'))

  let fetchCalled = false
  await assert.rejects(
    startBake([path], {
      log: () => {},
      env: {},
      fetch: async () => {
        fetchCalled = true
        return reply({ title: 't' })
      }
    }),
    // The exact wording of resolveBakeModel's own guard, not merely something
    // that happens to mention "model" — a zod validation error on a missing
    // required field would satisfy a looser /model/i check without proving
    // resolveBakeModel's guard ran at all.
    /a model is required for bake — pass --model, or set/
  )
  assert.equal(fetchCalled, false)
})

test('startBake generates a fixture through an injected source and flushes the store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-bake-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('t'))

  const { store, flushCalls } = trackedMemoryStore()
  const lines: string[] = []

  const summary = await startBake([path], {
    log: (line) => lines.push(line),
    env: { OPENAI_MODEL: 'test-model' },
    fetch: async () => reply({ title: 't' }),
    createStore: async () => store,
    now: () => 0
  })

  assert.equal(summary.generated, 1)
  assert.equal(summary.failed, 0)
  assert.equal(flushCalls(), 1)
  assert.equal(store.records().length, 1)
  assert.equal(store.records()[0]?.operationId, 'ping')
  assert.ok(lines.some((line) => line.includes('baked 1 fixture')))
})

test('startBake still flushes the store when every generation attempt fails', async () => {
  // Invariant 4 applied to bake specifically: a source that refuses or errors
  // must not skip the write of whatever was already loaded/generated. If
  // `flush()` were only called on the success path, this run — 0 generated —
  // would prove nothing either way, which is why `flushCalls()` is asserted
  // directly rather than inferred from the summary.
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-bake-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('t'))

  const { store, flushCalls } = trackedMemoryStore()

  const summary = await startBake([path], {
    log: () => {},
    env: { OPENAI_MODEL: 'test-model' },
    fetch: async () => new Response(null, { status: 500 }),
    createStore: async () => store,
    now: () => 0
  })

  assert.equal(summary.generated, 0)
  assert.equal(summary.failed, 1)
  assert.equal(flushCalls(), 1)
})

test('startBake writes fixture files to disk through the real store (proves flush() is awaited)', async () => {
  // Deliberately does NOT override createStore: this exercises the real
  // createDiskFixtureStore and its 250ms debounce. Reading the file back
  // immediately after startBake resolves, with no wait of our own, would fail
  // with ENOENT if the implementation's `await store.flush()` were ever
  // dropped — the debounced write would not have happened yet.
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-bake-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('t'))
  const fixturesDir = join(directory, 'fixtures')

  const summary = await startBake([path, '--fixtures', fixturesDir], {
    log: () => {},
    env: { OPENAI_MODEL: 'test-model' },
    fetch: async () => reply({ title: 't' })
  })

  assert.equal(summary.generated, 1)

  const written = JSON.parse(await readFile(join(fixturesDir, 'ping.json'), 'utf8')) as Record<
    string,
    Record<string, { value: unknown }>
  >
  const entries = Object.values(written['200'] ?? {})
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0]?.value, { title: 't' })
})

test('mockingham bake is dispatched to the bake subcommand, not treated as a document', async () => {
  // If `bake` fell through to the serve path, parseArgs would treat "bake"
  // as the document filename and startCli would fail trying to read it —
  // an ENOENT, not this message. Checking for both is what proves dispatch
  // happened rather than merely happening to produce a similar-looking error.
  const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'bake'], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ exitCode: code, stderr }))
    }
  )

  assert.equal(exitCode, 1)
  assert.ok(stderr.includes('a document path is required'))
  assert.ok(!stderr.includes('ENOENT'))
})

test('mockingham bake --help prints the bake usage, distinct from the serve usage, and exits 0', async () => {
  const { exitCode, stdout } = await new Promise<{ exitCode: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'bake', '--help'], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ exitCode: code, stdout }))
    }
  )

  assert.equal(exitCode, 0)
  assert.ok(stdout.includes('mockingham bake'))
  assert.ok(!stdout.includes('OpenAPI driven HTTP mock server'))
})

test('mockingham bake exits 1 with a clear message when no model is configured anywhere', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mockingham-bake-'))
  const path = join(directory, 'api.json')
  await writeFile(path, doc('t'))

  const childEnv = { ...process.env }
  delete childEnv.OPENAI_MODEL
  delete childEnv.MOCKINGHAM_LLM_MODEL

  const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, 'bake', path], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: childEnv
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ exitCode: code, stderr }))
    }
  )

  assert.equal(exitCode, 1)
  assert.ok(stderr.includes('a model is required for bake — pass --model, or set'))
})

test('BAKE_USAGE names every bake flag', () => {
  for (const flag of ['--base-url', '--model', '--api-key', '--fixtures', '--persona', '--help']) {
    assert.ok(BAKE_USAGE.includes(flag), `BAKE_USAGE is missing ${flag}`)
  }
})
