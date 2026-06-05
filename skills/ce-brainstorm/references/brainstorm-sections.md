# Brainstorm Sections

This reference describes the rendering and ordering conventions for brainstorm
requirements documents. It does NOT prescribe which sections exist or what they
must contain — section inventory, content rules, and the document template live
in `references/requirements-capture.md`.

Rendering is handled by `references/markdown-rendering.md`.

## Brainstorm metadata fields

Every brainstorm carries a small set of stable metadata fields that
downstream tooling depends on. The contract is format-independent: these
fields appear as YAML frontmatter at the top of the file. Field names and
semantics are stable so consumers can locate them without knowing which
session produced the brainstorm.

### Required

- **`date`** — creation date in ISO 8601 (`YYYY-MM-DD`), ASCII digits only.
  Used in the filename (`docs/brainstorms/YYYY-MM-DD-<topic>-requirements.md`).
- **`topic`** — kebab-case slug identifying the brainstorm subject (e.g.,
  `surface-scope-earlier`, `demo-reel-local-save`). Used in the filename
  alongside `date` and as the resume-detection key when `ce-brainstorm`'s
  Phase 0.1 scans `docs/brainstorms/` for an existing artifact to continue.

### Status flip does not apply to brainstorm

Unlike plans, brainstorm artifacts have no `status` field — there is no
`active → completed` lifecycle. A brainstorm is a one-time output that
downstream consumers (`ce-plan`, `document-review`) reference via the plan's
`origin:` field.

### Field-name stability

Field names are stable across brainstorm revisions — never rename a field
or repurpose its semantics. Agents composing new brainstorms MUST use these
exact names; adding new fields is fine, but renaming `topic` to `subject`
or `date` to `created` breaks filename construction and resume detection.

## ID and content rules

- **Stable IDs.** R-IDs (Requirements), A-IDs (if Actors fire), F-IDs (if
  Flows fire), AE-IDs (if Acceptance Examples fire). No other ID namespaces.
- **Plain prefix.** `R1.`, `A1.`, `F1.`, `AE1.` as bullet prefixes. Do not
  bold; the prefix is visually distinctive on its own.
- **Bold leader labels** inside Flows and Acceptance Examples
  (`**Trigger:**`, `**Covers R4, R8.**`) provide structure without deeper
  heading levels.
- **Repo-relative paths.** Always. Never absolute paths.
- **No process exhaust.** No "captured at Phase X" notes, no `## Next Steps`
  pointing to ce-plan, no italic provenance lines. Engineering process
  metadata belongs in commit messages and tool output, not the artifact.
- **No implementation details by default.** Libraries, schemas, endpoints,
  file layouts, code structure stay out unless the brainstorm itself is
  inherently about a technical or architectural change and those details are
  the subject of the decision.

## Discipline: Summary vs Problem Frame

When both sections are present, they earn separate sections only by holding
to different purposes:

| Section | Question it answers | Time direction | Length |
|---|---|---|---|
| `## Summary` | What is this doc proposing? | Forward-looking | 1-3 lines |
| `## Problem Frame` | Why does this proposal exist? | Backward-looking / situational | Paragraphs |

- **Summary doesn't need problem context.** A reader scanning Summary gets
  the proposal at a glance.
- **Problem Frame doesn't restate the proposal.** It establishes the
  situation, the specific moment of pain, and the cost shape — then stops.
  The remedy lives in Summary; restating it in Problem Frame is the
  duplication that makes the two sections feel redundant.

## Rendering

The format-specific reference describes how to render these sections:

- **Markdown rendering:** `references/markdown-rendering.md`

This reference (`brainstorm-sections.md`) is about rendering conventions and
metadata contracts; section content rules live in `references/requirements-capture.md`.
