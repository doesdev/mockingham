# mockingham

OpenAPI-driven HTTP mock server. TypeScript, ESM, Node >= 24.

**The design spec is `docs/superpowers/specs/2026-08-11-mockingham-design.md`.**
Read the section relevant to your task before writing code. It is the contract;
this file is only the operating manual.

## Commands

```sh
npm test                 # node --test — runs .ts tests directly, no build
npx tsc --noEmit         # typecheck
node --test test/spec/   # scope tests to one directory
```

## Non-negotiable invariants

Breaking any of these is a defect even if tests pass.

1. **One schema interpretation.** `schema/walk.ts` is shared by value generation
   and zod compilation. Never add a second traversal — "what we generate" and
   "what we validate" diverging is the worst bug class in this project.
2. **Determinism.** The same request must produce byte-identical output across
   processes. Never introduce `Math.random()`, `Date.now()`, or iteration over
   an unordered `Set`/object into a generation path. Randomness comes from the
   seeded PRNG in `generate/rng.ts`; time comes from an injectable clock.
3. **The core is pure.** `server/handler.ts` and everything it imports must not
   touch Node APIs. Node-only code belongs in `server/node.ts` or `server/cli.ts`.
4. **A fixture or LLM miss is never an error.** It falls through to seeded
   generation. The mock must keep serving when the LLM is slow, absent, or refuses.
5. **Errors stay on-contract.** Emit the operation's declared error schema when
   one exists; only fall back to the built-in envelope when it does not.

## Code conventions

- **Erasable syntax only** — Node strips types natively, so no `enum`, no
  `namespace`, no parameter properties. Use `const X = {...} as const` instead of
  `enum`.
- `zod` is the only hard runtime dependency. `@anthropic-ai/sdk` and
  `@modelcontextprotocol/sdk` are optional peer deps, imported lazily inside the
  function that needs them — never at module top level.
- Tests live in `test/` mirroring `src/`, written in TypeScript, run by `node:test`.
- Write the test first, watch it fail, then implement.

## Shell conventions

These exist to keep autonomous runs from stalling on permission prompts.

- **Never use heredocs** (`<<'EOF'`). They read from stdin, which defeats command
  matching and forces a prompt. To write a file, use the Write tool. For a
  multi-paragraph commit message, pass repeated `-m` flags — each becomes its own
  paragraph:

  ```sh
  git commit -m 'feat: add route matcher' -m 'Static segments beat dynamic ones at equal depth.'
  ```

- **Prefer single quotes** in shell arguments. Double quotes invite `$` and
  backtick interpolation; single quotes are inert. Avoid apostrophes in commit
  messages so single quoting always works.
- **Avoid `&&` chains** for anything that writes. Run the commands as separate
  calls — a chain is matched as a unit and one unmatched half prompts for both.
- **Never `cd`.** Use absolute paths; `cd` inside a compound command triggers a
  prompt.
- **Prefer the dedicated tools** — Read, Write, Edit, Glob, Grep — over `cat`,
  `sed`, `find`, and `grep`. They are faster, never prompt, and do not need quoting.
- `git push`, `npm publish`, `rm -rf`, and `sudo` are denied by policy. If you
  think you need one, stop and ask rather than working around it.
