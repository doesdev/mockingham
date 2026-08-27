# mockingham

OpenAPI-driven HTTP mock server. TypeScript, ESM, Node >= 24.

**The design spec is `docs/superpowers/specs/2026-08-11-mockingham-design.md`.**
Read the section relevant to your task before writing code. It is the contract;
this file is only the operating manual.

## Commands

```sh
npm test                 # node --test - runs .ts tests directly, no build
npm run typecheck        # tsc --noEmit
npm run build            # tsc -p tsconfig.build.json - emits dist/, run by prepack
npm run check:package    # what a publish would actually ship
npm run check:install    # packs, installs the tarball elsewhere, imports it
npm run determinism      # the script the cross-process test spawns twice
node --test test/spec/   # scope tests to one directory
node src/server/cli.ts docs/example.json --port 4000   # run the mock from a document
```

Development runs the TypeScript directly under native type stripping; what is
PUBLISHED is compiled JavaScript, because Node refuses to strip types under
`node_modules`. `npm run build` is what bridges the two, and `prepack` runs it
so a publish cannot ship a stale or missing `dist/`.

CI (`.github/workflows/ci.yml`) runs `typecheck` and `test` on Node 24 and
current LTS, `check:package` and `check:install` in a separate job, and an
advisory job on the newest Node - development still rides on native type
stripping, so a break in an unreleased line is worth seeing early and is not a
reason to block a pull request. `npm ci` there will fail if the lockfile and
`package.json` disagree, which is deliberate.

**`check:install` is the only check that leaves the repository, and that is the
point.** Every test here reaches into `src/` by relative path, so a package
whose published entry points cannot be loaded at all passes the entire suite -
which is exactly what shipped in 0.2.0. If a defect's precondition is a
property of the ENVIRONMENT rather than of the code, no in-repo test can see
it.

## Non-negotiable invariants

Breaking any of these is a defect even if tests pass.

1. **One schema interpretation.** `schema/walk.ts` is shared by value generation
   and zod compilation. Never add a second traversal - "what we generate" and
   "what we validate" diverging is the worst bug class in this project.
2. **Determinism.** The same request *sequence* must produce byte-identical
   output across processes: replay an identical sequence against a fresh
   process with the same seed and every step matches. Sequence, not a lone
   request - response linking, idempotency replay, request ordinals, the
   webhook counter and armed `failNext` failures each already make a response
   depend on what came before it. Read the bare "same request" form as the
   special case it is; the refinements design §4.5 is where the amendment is
   argued. Never introduce `Math.random()`, `Date.now()`, or iteration over an
   unordered `Set`/object into a generation path. Randomness comes from the
   seeded PRNG in `generate/rng.ts`; time comes from an injectable clock, and
   UUIDv7 timestamps from the seeded allocator in `generate/clock.ts`, which
   must be reserved synchronously before any await.
3. **The core is pure.** `server/handler.ts` and everything it imports must not
   touch Node APIs. Node-only code belongs in `server/node.ts` or `server/cli.ts`.
4. **A fixture or LLM miss is never an error.** It falls through to seeded
   generation. The mock must keep serving when the LLM is slow, absent, or refuses.
5. **Errors stay on-contract.** Emit the operation's declared error schema when
   one exists; only fall back to the built-in envelope when it does not.
6. **Emission never affects the response.** Webhooks fire at the single exit,
   after the response is final. A throw in an emit override, in signing, or in
   delivery reaches `onError` - never the caller. An emit that resolves no
   destination is captured as `unresolved`, not an error.

## Code conventions

- **Erasable syntax only** - Node strips types natively, so no `enum`, no
  `namespace`, no parameter properties. Use `const X = {...} as const` instead of
  `enum`.
- `zod` is the only hard runtime dependency. `@anthropic-ai/sdk` and
  `@modelcontextprotocol/sdk` are optional peer deps, imported lazily inside the
  function that needs them - never at module top level.
- Tests live in `test/` mirroring `src/`, written in TypeScript, run by `node:test`.
- Write the test first, watch it fail, then implement.
- **US English spelling** everywhere - identifiers, test names, comments, docs.
  Write `honor`, `behavior`, `serialize`, `normalize`, `canceled`, not the
  British variants.

## Shell conventions

These exist to keep autonomous runs from stalling on permission prompts. A
permission rule matches a command by its literal prefix, so **any shell
metacharacter makes a command unmatchable and forces a prompt** - even when every
individual part of it would have been allowed on its own.

**The rule: one plain command per Bash call, with literal arguments.**

Never put any of these in a Bash call:

| Forbidden | Instead |
|---|---|
| `&&`, `\|\|`, `;` chains | One Bash call per command |
| `\|` pipes | Use the Grep tool, or read the output yourself |
| `$(...)` or backticks | Run the inner command as its own call and use the result |
| `VAR=value cmd` prefixes | Write the value literally into the command |
| `<<'EOF'` heredocs | Use the Write tool |
| `>`, `>>` redirects | Use the Write tool |
| `cd x && ...` | Absolute paths - never `cd` |

If a check genuinely needs composition, write a script with Write and run it as a
single command (`node scripts/check.ts`). That is one matchable command, and it
is reviewable and re-runnable besides.

Also:

- **Prefer single quotes.** Double quotes invite `$` and backtick interpolation;
  single quotes are inert. Avoid apostrophes in commit messages so single quoting
  always works.
- **Multi-paragraph commits use repeated `-m` flags** - each becomes its own
  paragraph. This replaces the heredoc pattern:

  ```sh
  git commit -m 'feat: add route matcher' -m 'Static segments beat dynamic ones at equal depth.'
  ```

- **Prefer the dedicated tools** - Read, Write, Edit, Glob, Grep - over `cat`,
  `sed`, `find`, and `grep`. They never prompt, need no quoting, and are faster.
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy. If you
  think you need one, stop and ask rather than working around it.
