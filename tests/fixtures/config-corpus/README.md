# config-corpus

Back-compat corpus for R13 of `docs/plans/2026-09-04-002-feat-model-config-profiles-plan.md`
("existing configs stay valid and produce identical OpenCode output"). Each
subdirectory is one corpus entry:

- `input.jsonc` — a user-level Systematic config (the file at
  `~/.config/opencode/systematic.jsonc`). Comments are permitted (the loader
  parses JSONC). Deliberately reuses shapes already exercised by existing
  fixtures under `tests/unit/config-handler.test.ts` and
  `tests/unit/config.test.ts` — no real user config was used to build this
  corpus.
- `expected.opencode.json` — the **canonical serialization** (object keys
  sorted recursively; `undefined` values omitted; 2-space indent; trailing
  newline) of the `config.agent` object `createConfigHandler` emits for that
  input, run against this repository's real `agents/`/`skills/` directories
  with no project or custom config layered on top.

`tests/unit/config-corpus.test.ts` asserts **byte-identity** of the
canonical serialization for every entry — not deep equality — so a change
that reorders keys or turns an absent field into an explicit `undefined`
fails the test even though `toEqual` would not catch it.

## How this corpus was built (provenance)

Built once, in Unit 6 of the model-config-profiles plan, from config shapes
that already existed as inline fixtures elsewhere in `tests/`. Before that
unit's `config-handler.ts`/`config.ts`/`config-schema.ts` changes landed,
each candidate input was run through **both** the pre-change hook (extracted
from git commit `84a9b40`, the last commit before Unit 1) and the
post-change hook, and the two canonical outputs were diffed — 0 differences
across all entries — before `expected.opencode.json` was generated from the
post-change hook and committed. This is the proof that the resolver-based
rewrite (Units 1–5) changed nothing observable for every config shape this
corpus covers.

## Entries 013-014

Entries `013-agent-model-clears-category-variant` and
`014-agent-model-null-clears-category-routing` pin the variant-binding rule: a
category sets both `model` and `variant`, and a more specific agent layer
overrides only `model` (013) or opts out with `model: null` (014). A variant
from a less specific layer than the winning model is dropped, and a null model
drops every variant. Both entries were verified against pre-feature `main`
(commit `324a87e`) with the reconstruction method above, with 0 differences.

## Adding an entry

1. Create a new numbered directory (`NNN-short-description/`).
2. Write `input.jsonc` — a plausible user-level config. Prefer reusing a
   shape from an existing test fixture over inventing one; never copy a real
   user's config.
3. Generate `expected.opencode.json` **deliberately** — run the corpus
   generation method (see `tests/unit/config-corpus.test.ts`'s
   `canonicalJson`/`runCorpusEntry` helpers, or a throwaway script that calls
   them against your new entry) against the **current, intentional**
   behavior, and commit the result alongside the code change that motivated
   the new entry.
4. Run `bun test tests/unit/config-corpus.test.ts` to confirm the new entry
   round-trips.

## Regenerating expected files

`expected.opencode.json` files are **never** regenerated automatically and
never regenerated to make a failing test pass without first understanding
*why* it changed. A corpus test failure means either:

- a regression (the fix is in the source, not the fixture), or
- an intentional behavior change (regenerate the specific entry's
  `expected.opencode.json` deliberately, explain the change in the PR
  description, and confirm no other entry changed unexpectedly).

There is no bundled regeneration script committed alongside this corpus —
regenerating is meant to be a deliberate, reviewed action, not a one-command
habit.
