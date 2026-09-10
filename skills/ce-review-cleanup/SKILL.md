---
name: ce-review-cleanup
description: Use when the operator wants to delete old systematic:ce-review run directories under .context/systematic/ce-review/ to free disk space or purge stale local review evidence. Use when asked to clean up, prune, or remove old review runs, review artifacts, or review-summary.json history.
metadata:
  harness-portability: neutral-v1
---

# Review Artifact Cleanup

Offline, operator-initiated deletion of old `systematic:ce-review` run directories. This skill must never dispatch a review, select a review mode, or create a new run while claiming writers are stopped. It only previews and deletes existing run directories through the bundled helper.

## Step 1: Identify the target root

Before asking anything else, fix the target project root for this invocation (the operator-supplied path, or the current checkout if none is given) and hold it as `TARGET_ROOT` for every command below. Every invocation in this skill -- preview and execute -- reuses this exact same value. The preview helper's JSON response carries no `root` field, so execute must never guess or reconstruct the root from that response; it must reuse the value fixed here.

## Step 2: Offline acknowledgment

Before any scan, ask the operator to confirm they have stopped all review writers using this checkout, including other sessions and other machines, and that they will remain stopped through deletion. This is a stated precondition, not a verified one: the helper does not detect active writers. If the operator refuses or cannot confirm, stop -- do not run preview.

## Step 3: Age cutoff

Ask for the age cutoff (days, or a number suffixed `d`/`w`) if the operator has not already supplied one. Age is a required argument with no default; never assume or infer a cutoff.

## Step 4: Preview

Fill `TARGET_ROOT` with the value fixed in Step 1 and `AGE` with the confirmed cutoff, then invoke the bundled helper for a read-only preview. Quote both values -- never interpolate operator text unquoted:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/cleanup.mjs" preview --root "$TARGET_ROOT" --age "$AGE" --ack-offline
```

Parse the JSON result:

- `result: "root-missing"` -- no review root exists; nothing to do, stop.
- `result: "nothing-eligible"` -- no candidate is old enough; report the `excludedRecent` count and the `skippedUnknownUnsafe` count separately (they are not the same thing: recency exclusion is not an unsafe/unknown skip), and stop.
- `result: "preview"` -- one or more candidates selected; continue to Step 5.
- `result: "error"` -- exit code 2 with a fixed `category` (e.g. `missing-acknowledgment`, `invalid-age`, `invalid-root`, `unsafe-review-root`, `root-enumeration-failed`). Report the category verbatim and stop. Never substitute an unchecked replacement command (no direct filesystem deletion, no ad hoc shell traversal) when the helper is missing or fails -- report a fixed diagnostic and stop.

Present each candidate's `name`, `displayId`, `label`, and `lastModified` -- the bounded, JSON-escaped `name` gives the operator a human-identifiable candidate alongside the hash-derived `displayId`, not instead of it. Render the `name` value as-is, never decode or reformat it into Markdown/terminal text: a candidate name is untrusted, JSON-escaped input, not markup. Present `skippedUnknownUnsafe` candidates with their `name`, `displayId`, and `reason`. Never print `review-summary.json` contents or any source excerpt. Status (completed, in-progress, failed, legacy, or missing) is never an eligibility signal; age past the cutoff under the offline precondition is the only selection criterion -- old in-progress and artifactless runs are exactly as eligible as old completed ones.

## Step 5: Deletion approval

After presenting the full preview, ask for a separate, explicit deletion approval -- never equate it with the offline acknowledgment or the initial cleanup request. Never treat the offline acknowledgment, the initial cleanup request, or the preview token as deletion approval. If the operator declines, stop; there is no autonomous default and no partial proceed.

## Step 6: Execute

On approval, fill `TARGET_ROOT` with the exact same value fixed in Step 1 (never a value read from the preview response) and `TOKEN` with the exact token string from the preceding preview response, then invoke execute. Quote both values; never recompute or pass `--age`:

```bash
# Resolve helper scripts relative to this skill's directory.
SKILL_DIR="<skill directory stated when this skill loads>";
node "$SKILL_DIR/scripts/cleanup.mjs" execute --root "$TARGET_ROOT" --ack-offline --token "$TOKEN"
```

Handle exit codes:

- `0`, `result: "deleted"` -- all approved candidates removed; report per-candidate outcomes.
- `1`, `result: "partial"` -- some candidates were skipped or failed; preserve and report every candidate's outcome (`deleted`/`skipped`/`failed`) rather than a single pass/fail summary.
- `2`, `result: "error"` -- invalid arguments, missing acknowledgment/token, or unsafe setup (including a future-dated token). Report the category and stop; no unchecked replacement command.
- `3`, `result: "preview-stale"` -- the reviewed tree changed since preview; zero deletions occurred. Run a fresh preview (Step 4) and ask for a renewed approval (Step 5) before executing again. Never auto-retry the same token.

## Scope and disclosures

- Only `.context/systematic/ce-review/` run directories are candidates; the root itself, `.context/.gitignore`, and other tools' artifacts are never deletion targets. An unknown or unreadable age skips the candidate; symlink and special-file candidates are refused.
- Deletion is irreversible and can partially remove a directory; there is no rollback or backup copy.
- Findings inside retained runs may contain source excerpts and remain on disk indefinitely until this cleanup runs; disclose that to the operator when relevant.
- This skill does not verify writer liveness, does not authenticate approval, and does not defend against a concurrent malicious filesystem replacement -- the offline precondition is the operator's responsibility, not the tool's.
