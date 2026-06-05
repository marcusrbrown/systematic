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

> **Section inventory, content rules, and the Summary vs Problem Frame discipline are owned by `references/requirements-capture.md`; this file covers rendering conventions and metadata contracts only.**

## Rendering

The format-specific reference describes how to render these sections:

- **Markdown rendering:** `references/markdown-rendering.md`

This reference (`brainstorm-sections.md`) is about rendering conventions and
metadata contracts; section content rules live in `references/requirements-capture.md`.
