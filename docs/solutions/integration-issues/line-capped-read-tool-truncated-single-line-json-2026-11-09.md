---
title: A model that reads one long JSON line through a line-capped read tool loses the tail
date: 2026-11-09
category: integration-issues
module: ce-connect
problem_type: integration_issue
component: assistant
symptoms:
  - "The researcher subagent missed rule entries that were in the rule index file"
  - "A work file written as one JSON line was cut by the host read tool at roughly 2000 characters"
  - "Helper unit tests that parsed the file with JSON.parse passed while the model saw a truncated document"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [read-tool, line-cap, json, truncation, subagent, work-files, tsv]
---

# A model that reads one long JSON line through a line-capped read tool loses the tail

## Problem

The `ce:connect` helper hands a read-only subagent its inputs as files in a run work directory. The subagent has `Read`, `Grep` and `Glob` only. The first version of the rule index was one `JSON.stringify` line. The host's read tool cuts a line at about 2000 characters, so the subagent saw the start of the document and silently lost the rest, including whole rule entries.

## Symptoms

- The subagent lost rule entries that were in the file. The cut left no error, only a shorter document.
- The file parsed with `JSON.parse` in a helper test. The cap is applied by the model's read tool, not by the file system, so a test that reads the file directly cannot see it.
- The same limit hides fingerprints. The run snapshot (`begin.json`) is a single line by design, so a model that tries to look up a file's hash there reads only its first 2000 characters.

## What Didn't Work

- **A parser test.** It reads the whole file from disk, bypassing the host's line cap.

## Solution

Write every file the model must read as short lines, and give it an index so it never has to read a whole file.

- **Indent the JSON.** `rules.json` is written with `JSON.stringify(..., null, 1)` in the `writeWorkFile` call (`src/ce-connect-helper.ts:1178-1182`). The file is still one valid document, and the observed index no longer has a line near the cap. Indentation does not wrap a long string value, so an individual value or entry can still exceed a line or read-window limit.
- **Add line-oriented indexes.** `files.tsv` has one tab-separated line per inventoried file (fingerprint, role, project root, path) and is built by `fingerprintIndex` (`src/ce-connect-helper.ts:390-406`). `rules.tsv` has one line per rule (id, project, path, title, `applies_when`, offered or later) and is built by `rulesOverview` (`src/ce-connect-helper.ts:362-388`). Control characters are collapsed or the line is dropped, so a path cannot break the format.
- **Tell the agent how to find an entry.** The agent's input description says to search the rules file for `"id": "<rule id>"` and read about 45 lines from the line the search reports, and to take fingerprints from the files index (`agents/research/connections-researcher.md:35-36`).

## Why This Works

A line cap only matters when one record spans more than one cap's worth of text. Indented JSON puts the fields of a record on separate lines, so a search hit gives a line number and a read from there returns the entry's fields in the usual case. Rule text is capped at 2000 characters per section (`SECTION_TEXT_CAP`, `src/lib/connect-helper-core.ts:93-94`), which is the same order as the read cap, so a single long value can still approach it and an entry is not guaranteed to fit in 45 lines. The TSV indexes answer the two lookups the agent repeats (which rules, and what hash for this path) in one short line each, so it does not read the large file at all.

## Prevention

- Assert on the longest line, not on parseability. The work-file test reads the rule file back, parses it, and asserts the maximum line length is under a limit just above the cap (`READ_LINE_LIMIT` in `tests/unit/ce-connect-helper-ops.test.ts:412-443`). The fixture is one rule whose guidance is about 1,440 characters, long enough to overflow the cap if the file were one line. It is not a bound on arbitrary content, so test the real input bounds and page when an entry is long.
- Pin the shape of each index file: one record per line, the exact column count, and no tab or line break inside a cell (`tests/unit/ce-connect-helper-ops.test.ts:445-527`).
- When a subagent has only read and search tools, treat the host read tool's limits as part of the contract of every file you give it. Check the real limit on the host you ship for; the 2000-character figure here was observed on OpenCode and is noted in the helper's own comment, and other hosts may cut differently.
- Keep single-line machine files (`begin.json`) out of the model's inputs. The model gets the indexes that were derived from them.

## Related Issues

- [OpenCode truncates plugin tool output before any hook runs](./plugin-tool-output-truncated-before-after-hook-2026-09-26.md): a different truncation, on a tool's result rather than on a file read by the model.
