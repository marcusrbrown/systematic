---
title: Reading other people's repositories needs an evidence boundary, a modest citation claim, and a user-only allow list
date: 2026-11-09
category: best-practices
module: ce-connect
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "A tool or skill reads repositories the user listed, and a repository is untrusted input"
  - "A model proposes findings that cite files and lines in those repositories"
  - "A new config field decides what the tool may read, and no project config may set it"
tags: [evidence-boundary, hardened-git, symlink-containment, fingerprint, citation-check, trust-protected-config, user-only-config, ce-connect]
---

# Reading other people's repositories needs an evidence boundary, a modest citation claim, and a user-only allow list

## Context

`ce:connect` reads the tracked files of several repositories the user listed and lets a model propose connections between them. A repository is untrusted input: its git config, its file names, its symlinks, and its text can all try to steer the reader. This note records the boundary around evidence the helper validates, what the citation check can honestly claim, and how the allow list that sits in front of it is protected from the repositories it names. It is not a sandbox for the model; see [Limits of this boundary](#limits-of-this-boundary).

## Guidance

### 1. Make the reader's authority small and fixed

- **Allow-list the git subcommands and harden the call.** The helper runs only `ls-files`, `cat-file` and `check-ignore` (`GIT_SUBCOMMANDS`, `src/lib/connect-evidence.ts:76-93`). Every call carries `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false`, because a repository's own config can name an fsmonitor command or a hooks directory that git would run for you. Paths go after `--` (`buildGitArgv`, `src/lib/connect-evidence.ts:110-126`). The environment is rebuilt from a short list: `PATH`, `HOME`, `TMPDIR` and two Windows variables, with `GIT_OPTIONAL_LOCKS=0` and no inherited `GIT_*` variable, so a stray `GIT_DIR` cannot redirect a read (`gitEnvironment`, `src/lib/connect-evidence.ts:128-150`). Everything is argv, never a shell.
- **Prove the hardening against a real hook.** The tests plant an fsmonitor hook that writes a marker file, assert that an unhardened `git status` fires it, and assert that the helper's call does not (`fsmonitor hook (negative control)`, `tests/unit/connect-evidence.test.ts:226-269`). A hardening test with no negative control proves nothing.
- **Drop what cannot be read safely before you open anything.** The listing is `ls-files -z --cached --stage`; mode 120000 (symlink) and 160000 (submodule) entries are counted and dropped, and so is anything unmerged or not a regular file (`classifyListingRecord`, `src/lib/connect-evidence.ts:985-1004`).
- **Read through one contained function.** `readContainedFile` refuses an absolute path, `..` or an empty segment, `lstat`s every ancestor and the final component, opens with `O_NOFOLLOW`, compares the opened descriptor's device and inode with the `lstat`, rechecks the ancestors after the open, and stops reading one byte past the size cap instead of trusting `stat` (`src/lib/connect-evidence.ts:391-438`).
- **Take fingerprints once.** The `sha256` of each file is taken when the run begins. A candidate's cited fingerprint is accepted only if it equals that hash, and the file as it is now must still hash to it (`fingerprintProblem` and `readCurrent`, `src/lib/connect-helper-core.ts:887-914`). A file that changed during the run is dropped as `changed-since-begin`, and the rule it concerned is not counted as covered.
- **Hold an excerpt to the claim it supports.** Excerpts must be at least 20 characters (`CANDIDATE_LIMITS`, `src/lib/connect-helper-core.ts:635-649`) and appear verbatim in the current file. A piece of target evidence must also contain the symbol it names, and that symbol must be inside the cited line span (`verifyTargetEvidence`, `src/lib/connect-helper-core.ts:987-1030`).
- **Pin exclusions with a case only the exclusion can fail.** The inventory leaves out `node_modules`, `.env*` names, lockfiles and `.min.js` (`isExcludedPath`, `src/lib/connect-evidence.ts:846-858`). A mutation that disabled the `.env*` rule survived the first tests. The test file's own comment gives the reason: a name whose extension is outside the config and code lists is dropped anyway. The exclusion test now marks each case as decisive or not, and every decisive name carries an extension the lists accept, so only the exclusion rule can keep it out (`EXCLUDED`, `tests/unit/connect-evidence.test.ts:387-415`). Four other exclusion rules (`.lock`, `.map`, `.lockb`, `.sum`) had no effect at all, because the eligibility lists already excluded those extensions, and they were removed as dead code.

### 2. A citation check reports which citations still hold, nothing more

`checkCitation` takes a path, a line span and a symbol, and returns one of three verdicts (`src/lib/connect-evidence.ts:535-570`):

- `passed`: the symbol occurs as a whole identifier inside the span.
- `not-in-span`, with `foundElsewhere`: the symbol is not in the span, and the flag says whether it occurs elsewhere in the file (the code moved) or nowhere (it is gone).
- `unchecked`, with a reason: no symbol was given, the span is invalid, or the file could not be read safely.

A file-and-line check alone passes when the cited text has moved, which is exactly the failure that matters, so the check compares the symbol inside the span. Two limits go with it:

- **The claim depends on what authors wrote.** When this was measured, only 46 of 137 learnings in one project carried a `path:line` citation (an earlier count gave 42 to 46). A project with none is `unsupported`, which is not the same as every citation holding (`reportProjectCitations`, `src/lib/connect-evidence.ts:745-785`).
- **The check is bounded.** It stops at a per-project cap (`maxCitationsPerProject`, 500, `src/lib/connect-evidence.ts:51-68`). In an evaluation over a real project set every project reached the cap, so "cap reached" is a fact to report and not a failure of the run.

The same shape is in `scripts/content-integrity.ts`, which checks the `path:line` citations in `docs/solutions/` for the symbol their sentence names.

### 3. The helper inventories and validates only what the user named

The allow list is `connect.allow_projects` in user-level config. It decides which projects the helper indexes and which paths it validates. Several things keep a repository from writing to it:

- **Classify the field at load and strip it from project config.** `config.ts` removes the whole `connect` block from a project source before schema validation and warns once, naming the file and the field but never a value (`PROJECT_ALWAYS_PROTECTED_FIELDS`, `src/lib/config.ts:463-466`; the warning at `src/lib/config.ts:2415-2425`).
- **Fail closed.** `validateConnectBlock` accepts an object whose only key is `allow_projects`. An unknown key, a wrong type, or a list over its limit makes that layer's block unreadable, and an unreadable block contributes no entries. A bad layer can never widen the list (`src/lib/connect-config.ts:74-104`).
- **Never read project config.** The helper's own reader opens user, user.local, custom and custom.local files only (`selectConnectConfigFiles`, `src/lib/connect-config.ts:184-210`).
- **Refuse containers a repository could control.** A custom config directory that is inside a checkout or inside an allowed root is refused and none of its files are opened. The state root is refused for the same reasons (`containerRefusal`, `src/lib/connect-config.ts:237-254`; `prepareStateRoot`, `src/lib/connect-state.ts:197-224`).
- **Pin discovery to the search reader.** The helper repeats the layer-discovery logic because the search reader imports zod, which the helper bundle cannot carry. A parity test asserts both pick the same files (`tests/unit/connect-config.test.ts:584-671`).

#### Recipe: add a user-only top-level config field

These are the edits `connect` needed, in order.

1. **Schema.** Add the field to the top-level object in `src/lib/config-schema.ts` and wrap its schema in `trustProtected(...)`, which tags it `project-or-higher` (`trustProtected` at `src/lib/config-schema.ts:177`; the `connect` block at `src/lib/config-schema.ts:506-531`; the field at `src/lib/config-schema.ts:640`).
2. **Shared protected-path list.** Add the path to `CONFIG_PROTECTED_FIELD_PATHS` in `src/lib/config-protected-fields.ts:21-38`. That module imports nothing, on purpose. `src/lib/capability-snapshot.ts` imports the list and validates every protected-field fact against it (`src/lib/capability-snapshot.ts:41-43`), so this one edit reaches the capabilities report, and `capability-snapshot.ts` itself needs no change. A hand-copied list there once made `systematic capabilities` fail with a cause-less message (see the module comment).
3. **Project strip and warning.** In `src/lib/config.ts`, add the name to `PROJECT_ALWAYS_PROTECTED_FIELDS` (`src/lib/config.ts:463-466`), report it in `collectProjectProtectedFields` (`src/lib/config.ts:1277-1316`), and emit the warning with `emitTopLevelProtectedFieldWarning` (`src/lib/config.ts:2415-2425`). The strip runs before schema validation, so a bad project block cannot break the file it sits in.
4. **Type, default and merge.** Add the field to `SystematicConfig` (`src/lib/config.ts:258-292`). If the absence of the field already means "off", leave it out of `DEFAULT_CONFIG`, as `connect` does. Add a merge function and spread it into the result, as `mergeConnect` does (`src/lib/config.ts:2217-2232` and its use at `src/lib/config.ts:2554`).
5. **Reference generator.** Add the key to the top-level list and, if the field has sub-fields, to a sub-field list and renderer in `docs/scripts/generate-config-reference.ts` (`TOP_LEVEL_KEYS` at `docs/scripts/generate-config-reference.ts:43-60`, `CONNECT_SUB_FIELDS` at `docs/scripts/generate-config-reference.ts:130-131`, `renderConnectSubFields` at `docs/scripts/generate-config-reference.ts:312-325` and its dispatch at `docs/scripts/generate-config-reference.ts:428-429`).

Then regenerate the surfaces (`bun run surfaces:affected --run`, then `bun run surfaces:drift`). `config-schema.ts` is a trigger of both the schema surface and the config-reference surface in `scripts/lib/generated-surfaces.ts`.

Finally, a test per edit: the path is in the shared list (`tests/unit/config.test.ts` asserts `CONFIG_PROTECTED_FIELD_PATHS` contains `connect`); a project value is stripped with one named warning and the user value is used; an unknown key makes the block unreadable and the list empty (`tests/unit/connect-config.test.ts:191-198`).

### Limits of this boundary

Everything above governs what the helper reads and what it accepts as evidence. It does not confine the researcher model:

- The researcher's read, grep and glob tools are not path-scoped. They can open any file the user can, inside the allow list or not.
- Session MCP tools are not denied.
- The candidate title and summary are written by the researcher and are not checked against evidence, so text from those reads can reach chat replies and run records, and so the model provider.
- Coverage is the researcher's own report.

Read every candidate before promoting it, and treat a digest like the learnings it quotes. The user guide's [Limits section](../../src/content/docs/guides/cross-project-connections.mdx) lists these in full.

## Why This Matters

Each layer assumes the one before it can be fooled. Hardened git does not matter if a symlink inside the tree reads `~/.ssh`. Containment does not matter if the fingerprint was taken after the file changed. A fine citation check does not matter if its verdict is read as "the learning is current". And none of it matters if a repository can add itself, or a sibling, to the list of things the tool reads. For helper-validated evidence, the boundary holds because every step re-derives what it trusts from the filesystem and from the begin-time hash, and never from the text the model returned. The free text around that evidence has no such guarantee.

## When to Apply

- A tool reads files from repositories the user did not author.
- A model's findings cite files and lines, and you present them with a confidence they have not earned.
- A new config field widens what the tool may touch, and a checked-in project config could otherwise set it.

## Examples

A file-and-line check says a citation is fine because line 12 exists. The symbol check asks whether the named symbol is in lines 12-18. If the symbol moved outside the span, the verdict is `not-in-span` with `foundElsewhere`.

## Related

- [Trust-sensitive overlay fields in plugin configuration](./layered-trust-boundaries-overlay-config-2026-05-09.md): the same strip-and-warn rule for overlay fields. This note covers a whole top-level block.
- [Match filesystem safety evidence to the operation](./match-filesystem-safety-evidence-to-the-operation-2026-09-10.md): choose the evidence for each filesystem operation.
- [A mutation that fails nothing needs a decision](./a-mutation-that-fails-nothing-needs-a-decision-2026-10-15.md): the dead exclusion rules were this case.
