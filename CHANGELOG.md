# Changelog

Notable changes per release. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely, and versions
follow semver with the usual 0.x caveat that a minor bump may change behavior.

Releases before 0.2.1 predate this file. 0.2.0 is summarized anyway, because
anyone who installed it needs to know why it did not work.

## 0.4.0 - 2026-08-27

Every schema keyword this project previously documented as unread is now read,
by the same single traversal that already fed both generation and validation.
A document declaring one of them was served and validated as though it were
absent; now it is honored in both directions.

### Added

- **`contains`, `minContains`, `maxContains`.** Generation draws matching
  members merged with whatever else governs the position, so a `contains`
  member still satisfies `items` or its tuple position. Validation counts
  matches exactly.
- **`propertyNames` and `patternProperties`.** A key matching a pattern is not
  "additional", so `additionalProperties: false` still admits it. Generation
  invents one member per pattern no declared property covers, drawing the name
  from the same documented regex subset `pattern` uses.
- **`dependentRequired` and `dependentSchemas`,** applied one level deep.
- **`not`.** Validation is exact. Generation draws from what the schema
  declares and redraws a bounded number of times, so a negation it can escape
  is escaped and one it cannot is served anyway.
- **Sibling shapes on arrays.** `type: array` with `items` declared beside a
  `oneOf`/`anyOf` keeps its array shape, as objects already did since 0.3.0.
- **Fixture scoping through unions and tuple positions.** `llm.scope` can now
  reach a property inside a union branch, a union's sibling base, and a
  specific `prefixItems` position.

### Fixed

- **A recursive document could be sent to an LLM provider.** The recursion
  guard followed `items`, `additionalProperties` and union variants, but not
  `prefixItems`, a union's sibling base, `contains`, `patternProperties`,
  `dependentSchemas`, `propertyNames` or `not`. A cycle routed through any of
  those produced a request whose JSON Schema self-referenced. It now follows
  every branch that carries a subschema, with one test per branch.
- **Generation emitted a body its own validator rejects.** A `required` name
  with no `properties` entry - `then: { required: ['reason'] }` is the ordinary
  way to write one - was enforced by validation and skipped by generation.
- **`allOf` silently dropped a member's `patternProperties`, `dependentSchemas`
  or `dependentRequired`.** Those now accumulate across members, as
  `properties` and `required` already did. `allOf` is a conjunction; last-wins
  was wrong for them.
- **`classify` and `siblingBase` disagreed about what a container is.** A
  schema whose only object evidence was `patternProperties` classified as an
  object and then had its sibling shape discarded beside a union. Both now ask
  one shared pair of predicates.
- **`items: false` crashed the compiler** on a tuple declared with the 2020-12
  closed spelling (fixed in 0.3.0's `prefixItems` work; noted here because the
  same code path gained `contains`).

### Changed

- A union with a sibling shape now folds the base and the chosen branch into
  one effective schema rather than generating them separately and overlaying
  one on the other. Generated values for such schemas may differ from 0.3.0.
  The overlay could lose information the fold keeps.
- `uniqueItems` is enforced on tuples as well as lists, in both directions.

## 0.3.0 - 2026-08-27

Findings 2 through 7 of a consumer report against 0.2.0. A minor rather than a
patch bump: documents that were being served wrong will change shape, and
requests that used to be accepted are now correctly rejected.

### Added

- `--max-depth <n>` on the CLI, which previously had no way to reach the
  `maxDepth` option at all.
- A warning, once per schema path, when the depth budget truncates a container.
  Truncation is otherwise indistinguishable from success at the HTTP layer.

### Fixed

- **`prefixItems` was never read.** Tuple positions generated as `null` and
  validated as unknown, so a caller could send anything of the correct length
  and get a 200. Both directions now read the tuple.
- **`if`/`then`/`else` and `uniqueItems` were never read.** Generated bodies
  violated both; requests violating either were answered 200.
- **A union declared beside `type: object` collapsed the whole subtree to
  `null`,** and compiled every branch to `unknown` - so the object's own
  properties were neither generated nor validated.
- **A union cost a level of the depth budget that an inline object did not,**
  so an otherwise identical document truncated a level earlier whenever a union
  appeared in it. Resolving a union is a decision about what a node is, not a
  step down the tree.
- An exhausted budget at a union yielded `null` where the document declared an
  object; it now yields `{}`, matching the object case.
- A tuple-shaped array query parameter is coerced per position.

### Changed

- **The default `maxDepth` is 12, was 3.** Three levels are reached by envelope
  structure alone, so an ordinary document was served truncated under a 200
  with nothing to signal it.
- A bare `required` with no `type` and no `properties` now reads as an object
  schema rather than as unknown, which is what makes a `required`-only union
  branch or `then` branch enforceable.

## 0.2.1 - 2026-08-27

### Fixed

- **The package could not be imported as published.** 0.2.0 shipped TypeScript
  as both its library entry point and its `bin`, on the reasoning that Node
  strips types itself. It does - except under `node_modules`, where stripping
  is refused by a documented restriction that no flag turns off. Every install
  failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, on every Node
  version, with no consumer-side workaround.

  The package now publishes compiled JavaScript with type declarations.
  TypeScript source still ships alongside it so the declaration and source maps
  resolve: a debugger still lands on the original `.ts` while Node loads `.js`.

### Added

- `npm run check:install`, which packs the tarball, installs it into an empty
  directory, imports the package by name and runs its bin. CI runs it. No test
  inside the repository could see this class of defect - every test reaches
  into `src/` by relative path, and even a self-referencing
  `import 'mockingham'` resolves to the working tree, where stripping is
  allowed. The suite was green for a package nobody could install.

## 0.2.0 - 2026-08-25

**Do not use. This release cannot be installed** - see 0.2.1 above. It is left
on the registry rather than unpublished so the version history stays honest.

Feature work in this release: response linking, `Prefer` variant selection,
webhook redelivery, the MCP write tools, and a webhook registry.
