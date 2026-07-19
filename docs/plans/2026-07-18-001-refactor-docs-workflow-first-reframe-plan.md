---
title: "refactor: Docs workflow-first reframe"
type: refactor
status: completed
date: 2026-07-18
shipped: "PR #666 (reframe), PR #663 (GFM table fix), PR #665 (config-key fix), plus the root-docs refresh in this PR"
origin: docs/brainstorms/2026-07-18-docs-workflow-first-reframe-requirements.md
---

# refactor: Docs workflow-first reframe

## Overview

Reframe Systematic's documentation to lead with its compound-engineering workflows (the ce:* pipeline) and demote supported harnesses to a supporting "works with OpenCode, Pi, and Claude Code" mention. Fold the two dedicated harness guide pages into a lean Installation doc with a hand-written on-page compatibility aid, migrate the honest-boundary detail into `HARNESSES.md`, and refresh the stale root project docs. Delivered as two PRs split by surface: PR-1 (docs site) and PR-2 (`generating-project-docs` refresh).

## Problem Frame

The docs over-index on which harnesses Systematic supports. The landing tagline reads "for OpenCode and Pi," Installation links out to a standalone Pi guide, and Guides carries two dedicated harness pages — framing Systematic as a harness-integration project rather than a compound-engineering workflow system that runs on several harnesses. Claude Code shipped in v3.2.0 but most docs still enumerate only OpenCode and Pi, and the root docs are stale (`ARCHITECTURE.md` effectively OpenCode-only; `STRUCTURE.md` names OpenCode and Pi, not Claude Code). See origin: `docs/brainstorms/2026-07-18-docs-workflow-first-reframe-requirements.md`.

## Requirements Trace

- R1. Landing page and Installation lead with the ce:* workflow; harnesses become a supporting mention.
- R2. Fold the two dedicated harness guide pages into Installation as brief per-harness install steps.
- R3. Remove the `pi-harness` and `claude-code-harness` guide pages; add redirects from their URLs to Installation.
- R4. Update docs-site locations naming only "OpenCode and Pi" to include Claude Code.
- R5. Folded Installation harness content points to `HARNESSES.md` for boundary detail instead of reproducing it.
- R6. Migrate the removed pages' boundary sections into `HARNESSES.md`, condensed to its tier-table style.
- R7. Refresh `README.md`, `ARCHITECTURE.md`, `STRUCTURE.md` via the `generating-project-docs` skill at `all` scope.
- R8. Refreshed README leads with workflows and names all three harnesses as supporting detail.
- R9. Installation carries a compact hand-written on-page compatibility aid (one line per harness) linking to `HARNESSES.md` for depth.

## Scope Boundaries

- Docs only — no harness capabilities or runtime behavior change.
- `HARNESSES.md` stays a repo-root reference; not published as an on-site page (Installation links to it via GitHub URL).
- No sidebar/nav restructuring beyond removing the two folded pages (Guides autogenerates).
- No changes to generated skill/agent reference pages.
- Not a landing-page visual redesign — editorial (emphasis + wording), not layout.
- R9 aid is hand-written, not generated from a source constant (harness install commands are stable; no existing source-of-truth constant to generate from; `HARNESSES.md` itself is hand-maintained).

## Context & Research

### Relevant Code and Patterns

- `docs/src/content/docs/getting-started/installation.mdx` — fold target. Sections: Prerequisites (L12), Install the OpenCode plugin (L16–46), `npx skills` (L48–110), Install into a Pi coding-agent project (L112–118, links to the Pi guide), Automatic asset discovery (L120). CC install subsection slots after the Pi section (before L120); R9 aid slots after the OpenCode `<Steps>` block (~L46–48).
- `docs/src/content/docs/guides/pi-harness.mdx` — Install (L10–28) folds into Installation; "Honest parity differences" (L39–53) migrates to `HARNESSES.md`.
- `docs/src/content/docs/guides/claude-code-harness.mdx` — Install (L10–22, marketplace commands) folds into Installation; "The layered model" table (L34–43) + "Honest capability boundary" (L45–51) migrate to `HARNESSES.md`.
- `docs/src/content/docs/index.mdx` — hero title (L2 frontmatter + L13), subtagline (L14), Pi card link (L135), "runs inside OpenCode or the Pi coding agent" (L160). Workflow-first reframe + CC additions land here.
- `docs/astro.config.mjs` — Guides autogenerates (L148); `redirects:` block (L9–15); site `description` (L41–42). Redirect **destinations** must be `/systematic/`-prefixed.
- `README.md` — sections at L26–91; harness mentions at L32, L36, L44, L50 (Pi guide link), L52, L58, L75–79 (OpenCode-only checklist).
- `HARNESSES.md` — existing capability matrix (L11–17) is the tier-table style R6 migrates into and R9 mirrors in condensed form. `HARNESSES.md:33` and `:83` cite `pi-harness.mdx:39-47` as the `[PI-6]` evidence pointer — re-anchor when the page is deleted.

### Institutional Learnings

- `auto-generated-install-commands-mdx-pitfalls-2026-06-06.md` — MDX table traps: `<name>` in a table cell parses as JSX (use `[name]`); copy buttons attach only to fenced ```bash``` blocks, not inline-code table cells. Verify against built `docs/dist/.../index.html`, not source.
- `astro-redirect-destinations-missing-base-prefix-2026-05-22.md` — Astro redirect **destinations do not auto-prefix `base`**; every destination must be `/systematic/<dest>/` by hand. Extend `tests/unit/docs-redirects.test.ts`. (HIGH — build-green/production-404 bug.)
- `verify-installed-artifacts-not-just-build-gates-2026-07-18.md` — the `[HARNESSES.md](../../../HARNESSES.md)` repo-relative-escape defect survives all static gates. The Installation→HARNESSES.md link must be an absolute GitHub URL, not a `../` escape. Grep built HTML for `../../../`.
- `claude-code-plugin-build-and-publish-architecture-2026-07-18.md` — per-harness namespaces differ: OpenCode/Pi use `ce:<name>` / `systematic:<category>:<name>`; Claude Code uses `systematic:<skill-dir>`. The aid's install commands must not collapse the three.
- `qualified-persona-ids-are-canonical-validated-references-2026-07-17.md` — do NOT strip qualified persona IDs in a "harness-neutral" instinct; they are phantom-validated by `checkReferenceIntegrity`.
- `mdx-heading-anchor-crashes-astro-build-2026-05-22.md` — no explicit `{#anchor}` on headings (crashes MDX build); let Starlight derive slugs. Use `{/* */}` not `<!-- -->` for MDX comments.
- `pre-push-live-server-screenshot-qa-2026-05-22.md` — `astro.config.mjs` redirect changes + new/removed MDX pages require a live redirect smoke (`curl -sLI .../<legacy>/ | grep -i location` showing `/systematic/`), not just `docs:build` HTTP 200.
- `verify-css-liveness-against-rendered-html-2026-06-04.md` — audit `docs/src/styles/custom.css` for selectors scoped to the removed pages; verify liveness against `docs/dist`, not source.
- `generating-project-docs/SKILL.md` (PR-2) — counts from live CLI (`bun src/cli.ts list ...`); no session/plan/skill/subagent leakage; README lean (no skill/agent/CLI tables, no Mermaid); preserve evolved structure; terse fact-first voice; new top-level sections need approval.

## Key Technical Decisions

- R9 aid is hand-written, not generated: harness install commands are stable, no source-of-truth constant exists to generate from, and `HARNESSES.md` (the canonical source) is itself hand-maintained — a generated on-page summary would be more rigorous than its own source. (User-confirmed.)
- Installation → `HARNESSES.md` link uses an absolute GitHub URL, not a repo-relative path — the docs site is the deploy target, and a `../../../HARNESSES.md` escape is a known context-coupled defect.
- Boundary content migrates to `HARNESSES.md` before the guide pages are deleted, so nothing is lost in an intermediate state.
- PR split by surface: docs site (PR-1) and root-doc refresh (PR-2), so each PR's blast radius stays on one surface and README is not edited twice.

## Open Questions

### Resolved During Planning

- Redirect target (root vs per-harness anchor): redirect both removed URLs to the Installation page root (`/systematic/getting-started/installation/`) — mirrors the existing quick-start→installation redirect; per-harness anchors add fragility for little gain.
- Where boundary detail lives when Installation links off-site: absolute GitHub URL to `HARNESSES.md` (resolved by the context-coupled-link learning).
- How much guide-page prose transfers to `HARNESSES.md`: migrate the boundary sections condensed to the existing tier-table style; `HARNESSES.md` already carries compressed versions, so this is a lift-and-merge, not a rewrite.

### Deferred to Implementation

- Exact phrasing of the workflow-first hero tagline and README lead — settled when editing, within the "lead with ce:* pipeline" intent.
- How the `generating-project-docs` `all` pass threads workflow-first framing — whether the skill's generation absorbs it directly or README needs a light manual pass after generation (PR-2, Unit 6).

## Implementation Units

### PR-1 — Docs site reframe

- [x] **Unit 1: Migrate boundary content into HARNESSES.md**

**Goal:** Move the two guide pages' honest-boundary sections into `HARNESSES.md` so nothing is lost when the pages are deleted, and re-anchor the `[PI-6]` citation.

**Requirements:** R6

**Dependencies:** None (additive; must precede Unit 4).

**Files:**
- Modify: `HARNESSES.md`

**Approach:**
- Migrate Pi "Honest parity differences" (`pi-harness.mdx:39-53`) and CC "The layered model" table + "Honest capability boundary" (`claude-code-harness.mdx:34-51`) into the relevant per-harness sections of `HARNESSES.md`, condensed to its existing tier-table/notes style (it already carries compressed versions — merge, don't duplicate).
- Re-anchor the `[PI-6]` evidence pointer at `HARNESSES.md:33` and `:83`: it currently cites `pi-harness.mdx:39-47`, which dies with the page. Point it at the absorbing `HARNESSES.md` section (stable header anchor) or the source `src/pi.ts` it describes.

**Patterns to follow:** The existing `HARNESSES.md` per-harness notes + evidence-marker style (`[PI-n]`, `[CC-n]`).

**Test scenarios:** Test expectation: none — reference doc content change. Verified via content-integrity gate (no dangling evidence pointers) and grep for the stale `pi-harness.mdx` citation returning zero hits.

**Verification:**
- `bun scripts/content-integrity.ts` clean.
- No remaining reference to `pi-harness.mdx` or `claude-code-harness.mdx` line ranges in `HARNESSES.md`.

- [x] **Unit 2: Fold install steps into Installation + hand-written compatibility aid**

**Goal:** Add per-harness install steps (OpenCode already present; absorb Pi; add Claude Code) and a compact hand-written on-page compatibility aid to the Installation doc.

**Requirements:** R2, R5, R9

**Dependencies:** Unit 1 (HARNESSES.md is the link target for boundary detail).

**Files:**
- Modify: `docs/src/content/docs/getting-started/installation.mdx`

**Approach:**
- Add `## Install into a Claude Code project` after the Pi section (before "Automatic asset discovery"), mirroring the Pi section shape: intro naming the marketplace flow + a fenced ```bash``` block with `claude plugin marketplace add marcusrbrown/systematic` then `claude plugin install systematic@systematic`.
- Rewrite the Pi section to carry its own brief install steps (absorb from `pi-harness.mdx:10-28`) instead of linking to the deleted guide; point boundary detail at `HARNESSES.md` via an **absolute GitHub URL**.
- Add the R9 compatibility aid after the OpenCode `<Steps>` block (~L46–48): a 3-row table, one row per harness, columns like `Harness | Install | Skill loading`, surfacing the per-harness namespace/tool difference (OpenCode/Pi `systematic_skill`; Claude Code native Skill tool). Link to `HARNESSES.md` (GitHub URL) for the full matrix.

**Execution note:** MDX-trap discipline — use `[name]`-style bracketed tokens, never `<name>`, in table cells; put every copyable command in a fenced ```bash``` block outside the table (copy buttons don't attach to table cells); no explicit `{#anchor}` on headings; `{/* */}` for any MDX comment.

**Patterns to follow:** The existing OpenCode `<Steps>` block and Pi section in `installation.mdx`; the condensed column style of the `HARNESSES.md` matrix.

**Test scenarios:** Test expectation: none — MDX content addition. Verified via built HTML (below), not source.

**Verification:**
- `bun run docs:build` succeeds.
- In `docs/dist/systematic/getting-started/installation/index.html`: the aid table renders (no broken markup), `[name]` tokens render literally, fenced commands carry copy buttons (`data-code=`), and the HARNESSES.md link is an absolute `https://github.com/...` URL — grep confirms no `../../../` escape.

- [x] **Unit 3: Workflow-first reframe across landing page and descriptions**

**Goal:** Lead with the ce:* workflow and add Claude Code everywhere docs name only OpenCode + Pi.

**Requirements:** R1, R4

**Dependencies:** None (independent of Units 1–2; can land in any order within PR-1).

**Files:**
- Modify: `docs/src/content/docs/index.mdx`
- Modify: `docs/src/content/docs/getting-started/installation.mdx`
- Modify: `docs/astro.config.mjs` (site `description` only)

**Approach:**
- `index.mdx`: reframe the hero title (L2 frontmatter + L13) and subtagline (L14) to lead with the ce:* pipeline (brainstorm → plan → work → review), with harnesses as a supporting "works with OpenCode, Pi, and Claude Code" line. Update the "runs inside OpenCode or the Pi coding agent" line (L160) to include Claude Code. Remove the Pi-guide link from the Quick Start Pi card (L135) — retarget to Installation or drop the link, keeping the card copy.
- `installation.mdx`: adjust the OpenCode-centric lead-in (L10) so it doesn't imply OpenCode-only.
- `astro.config.mjs`: update the site `description` (L41–42) and any `og:description` naming only OpenCode + Pi.

**Patterns to follow:** Existing hero/splash structure in `index.mdx`; keep the editorial voice.

**Test scenarios:** Test expectation: none — editorial content change. Verified via `docs:build` + rendered-HTML grep.

**Verification:**
- `bun run docs:build` succeeds; landing renders.
- Grep `docs/dist` for "OpenCode and Pi" / "OpenCode or the Pi" — zero remaining harness-pair mentions that omit Claude Code (outside legitimately two-harness contexts).

- [x] **Unit 4: Remove guide pages, add redirects, extend redirect test, audit CSS**

**Goal:** Delete the two folded guide pages and preserve their URLs via base-prefixed redirects.

**Requirements:** R3

**Dependencies:** Unit 1 (boundary content preserved), Unit 2 (install steps folded).

**Files:**
- Delete: `docs/src/content/docs/guides/pi-harness.mdx`
- Delete: `docs/src/content/docs/guides/claude-code-harness.mdx`
- Modify: `docs/astro.config.mjs` (redirects)
- Modify: `tests/unit/docs-redirects.test.ts`
- Modify: `docs/src/styles/custom.css` (only if dead selectors found)

**Approach:**
- Add to the `redirects:` block: `'/guides/pi-harness/': '/systematic/getting-started/installation/'` and `'/guides/claude-code-harness/': '/systematic/getting-started/installation/'`. **Destinations MUST carry the `/systematic/` base prefix** — this is the build-green/production-404 trap.
- Guides sidebar autogenerates, so no explicit sidebar entry to remove.
- Audit `docs/src/styles/custom.css` for selectors scoped to the removed pages; remove only those proven dead against `docs/dist`.

**Execution note:** Extend `tests/unit/docs-redirects.test.ts` to assert both new redirects exist AND every destination starts with the configured `/systematic` base.

**Patterns to follow:** The existing quick-start→installation redirect entry and its comment style; the existing assertions in `tests/unit/docs-redirects.test.ts`.

**Test scenarios:**
- Happy path: `tests/unit/docs-redirects.test.ts` asserts `/guides/pi-harness/` and `/guides/claude-code-harness/` map to `/systematic/getting-started/installation/`.
- Edge case: assertion that every redirect destination (all entries, not just the new ones) begins with `/systematic/` — guards the base-prefix trap for the whole block.

**Verification:**
- `bun test tests/unit/docs-redirects.test.ts` passes.
- `bun run docs:build` succeeds; built `docs/dist/guides/pi-harness/index.html` (and CC) emit a redirect whose `Location`/refresh URL includes `/systematic/`.
- Live smoke: `bun run docs:dev`, then `curl -sLI http://localhost:4321/systematic/guides/pi-harness/ | grep -i location` shows the `/systematic/` destination.

### PR-2 — Root project docs refresh

- [x] **Unit 5: Refresh README / ARCHITECTURE / STRUCTURE via generating-project-docs**

**Goal:** Bring the root docs to current three-harness reality with workflow-first framing, using the `generating-project-docs` skill at `all` scope.

**Requirements:** R7, R8

**Dependencies:** None (separate PR; independent of PR-1, though ideally lands after so the docs-site state is settled).

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `STRUCTURE.md`

**Approach:**
- Invoke `generating-project-docs` at `all` scope. Thread the workflow-first positioning: README leads with the ce:* pipeline (promote the existing "First Workflow" loop), then introduces OpenCode/Pi/Claude Code as supporting; `ARCHITECTURE.md` and `STRUCTURE.md` gain Claude Code coverage (CC plugin build-and-publish, `setup --harness`, the three-harness delivery model).
- Fix the `README.md:50` Pi-harness guide link (dangling once the docs-site page is gone) — retarget to Installation or the harness guide's new home.
- Re-derive every count from live CLI (`bun src/cli.ts list skills/agents/commands`); no carryover.

**Execution note:** Honor the skill's hard rules — no session/plan/skill/subagent leakage; README stays lean (no skill/agent/CLI tables, no Mermaid); preserve evolved structure; terse fact-first voice; no new top-level sections without approval.

**Patterns to follow:** `.agents/skills/generating-project-docs/SKILL.md` section-order and style rules; the existing evolved structure of each doc.

**Test scenarios:** Test expectation: none — generated doc content. Verified via the skill's own quality checks (counts match live CLI, no local paths/secrets, cross-references resolve, headings monotonic).

**Verification:**
- Every skill/agent count in the refreshed docs matches `bun src/cli.ts list` output exactly.
- No `pi-harness`/`claude-code-harness` dangling links; `README.md:50` retargeted.
- Cross-references between README/ARCHITECTURE/STRUCTURE resolve; no `/Users/...` paths or session/plan leakage.

## System-Wide Impact

- **Interaction graph:** Removing the two guide pages affects the Guides sidebar (autogenerated — self-heals) and two inbound links (`installation.mdx:114`, `index.mdx:135`) folded/removed in PR-1; `README.md:50` handled in PR-2.
- **Error propagation:** Redirect base-prefix errors surface only in production (build stays green) — mitigated by the extended redirect test + live curl smoke.
- **API surface parity:** `HARNESSES.md` `[PI-6]` citation is the one cross-file evidence pointer that breaks on page deletion — re-anchored in Unit 1.
- **Unchanged invariants:** No skill/agent content, no runtime behavior, no config schema. `content-integrity` and qualified-persona-ID validation stay green (no bulk harness-neutral rename of persona IDs).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Redirect destinations missing `/systematic/` base → production 404 while build is green | Base-prefixed destinations + extended `tests/unit/docs-redirects.test.ts` asserting every destination starts with `/systematic/` + live curl smoke |
| MDX table traps (`<name>` JSX parse, copy buttons on table cells) break the aid | Bracketed `[name]` tokens; fenced ```bash``` blocks outside the table; verify against built `docs/dist` HTML |
| Context-coupled `../../../HARNESSES.md` link ships broken | Absolute GitHub URL for the HARNESSES.md link; grep `docs/dist` for `../../../` |
| Boundary content lost between page deletion and migration | Unit 1 (migrate) precedes Unit 4 (delete) |
| `HARNESSES.md` `[PI-6]` citation dangles on page deletion | Re-anchored in Unit 1 |
| PR-2 regenerates with stale counts or session leakage | Live-CLI counts + skill's no-leakage/lean rules in the Execution note |

## Documentation / Operational Notes

- PR-1 and PR-2 both warrant rich PR bodies (the "why": three harnesses × two dedicated pages = drift with no net-new information; workflow-first is the product's actual identity). `docs:`-scoped commits are non-releasing, so the PR body carries the editorial weight.
- PR-1 pre-push gate: `bun run docs:build` + `docs/dist` grep for `../../../` and dangling `HARNESSES.md` + curl redirect smoke + `bun test tests/unit/docs-redirects.test.ts`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-18-docs-workflow-first-reframe-requirements.md](docs/brainstorms/2026-07-18-docs-workflow-first-reframe-requirements.md)
- Related code: `docs/src/content/docs/getting-started/installation.mdx`, `docs/src/content/docs/index.mdx`, `docs/astro.config.mjs`, `HARNESSES.md`, `tests/unit/docs-redirects.test.ts`, `.agents/skills/generating-project-docs/SKILL.md`
- Learnings: `docs/solutions/integration-issues/astro-redirect-destinations-missing-base-prefix-2026-05-22.md`, `docs/solutions/best-practices/auto-generated-install-commands-mdx-pitfalls-2026-06-06.md`, `docs/solutions/workflow-issues/verify-installed-artifacts-not-just-build-gates-2026-07-18.md`, `docs/solutions/best-practices/claude-code-plugin-build-and-publish-architecture-2026-07-18.md`
