---
title: Support a host only after observed evidence that its tool limits hold
date: 2026-11-09
category: best-practices
module: host-support-table
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - "A feature claims a subagent cannot run commands, write, edit or fetch, and the claim differs per harness"
  - "Adding a host or a host version to a support or compatibility table"
  - "Writing a proof that a deny holds, or a negative control for one"
  - "Shipping a read-only agent to OpenCode, Pi or Claude Code"
tags:
  - host-support
  - host-evidence
  - negative-control
  - subagent
  - opencode
  - pi
  - claude-code
  - manual-evidence
---

# Support a host only after observed evidence that its tool limits hold

## Context

A read-only subagent declares its limits in frontmatter, and each harness reads that frontmatter differently. The same file is a hard boundary on one host, a partly enforced hint on another, and a no-op on a third. A table that lists hosts as "supported" because the definition looks right makes a security claim nobody observed. The researcher behind `ce:connect` ships to four host lines, so the rule below decides which of them may run without the user's consent.

## Guidance

**1. A row requires host-specific evidence that the tool limits work, on that version.** The evidence differs in strength: real-host refusal tests (OpenCode v1 and v2), an allowlist reaching a session builder (Pi), or a recorded manual tool-list observation (Claude Code). `HOST_SUPPORT_TABLE` lists one host and version per row, and each row names its evidence in `observedBy` (`src/lib/connect-config.ts:555-606`, `HostSupportRow` and `HOST_SUPPORT_TABLE`). A row without `observedBy` never matches, and a version whose normalized value is not listed is unsupported, whether older or newer (`src/lib/connect-config.ts:635-652`, `checkHostSupport`). The OpenCode v1, v2 and Pi rows bump with their pins in the same Renovate PR, through a `// renovate:` annotation above each version, and the proofs those rows name run at the proposed version in that PR. The row change is not the evidence; the proof run is. The Claude Code row moves only with a new manual run.

Normalization drops a leading `v` and everything after the first `+` (`src/lib/connect-config.ts:622-628`, `normalizeVersion`), so any build with the same normalized version matches, fork builds included, without its own observation. The evidence covers the one build that was tested. Verify a modified fork separately before relying on the boundary. See [a host-printed version can carry build metadata](../logic-errors/host-version-build-metadata-broke-support-table-match-2026-11-09.md).

**2. `observedBy` must resolve to something that exists.** It is `<file> > <test title>` for an automated proof, or `HARNESSES.md > <entry id>` for a manual one. A unit test checks that every named test title is still in its file, and that every manual entry exists, is marked `Manual evidence`, contains the row's exact version and contains `PASS` (`tests/unit/connect-config.test.ts:978-1014`, the `observedBy` and manual-evidence tests). The test allows a manual entry only for `claude-code`, the one host here that a scripted model cannot drive.

**3. A definition test is a regression pin, never proof.** A test that reads the frontmatter shows the entry is still there. It does not show a host enforces it. The unit tests that pin the shipped definition say so in their header comment.

**4. Prove against the shipped agent.** The first version of the proofs ran against a probe fixture agent that had drifted from the real definition. The real-host proofs now assert the agent that ran is the committed file (`expect(run.packaged).toBe(readShippedDefinition())`, `tests/integration/opencode-v2.test.ts:1545-1567`).

**5. Every automated deny proof needs a negative control that fails under its own name with the child reached.** Remove the limits and the same script must write the file and return an `isolation-breach` verdict. Assert the child's requests are non-empty, so the failure is "the limits are gone" and not "the dispatch never happened". Make the control throw when it has nothing to remove, so it cannot pass vacuously against a definition that never denied anything (`tests/helpers/connect-delegated-proof.ts:208-229`, `withoutDenyEntries` and `withoutExternalDirectoryAllow`). The prior art for scripted proofs is [Prove a dispatched subagent reached a plugin tool on a real host](prove-a-dispatched-subagent-reached-a-plugin-tool-on-a-real-host-2026-10-31.md); deny proofs add the three rules above.

**6. A scripted model proves enforcement plumbing, not model choice.** Say so next to the row. Evidence that the limits work (a refusal, an allowlist reaching the session builder, a recorded tool list) is not evidence that a live model would not try something else.

**Per-host facts that decide what the proof has to look like:**

| Host | What restricts the agent | Trap |
|---|---|---|
| OpenCode v1 | The `permission:` map. A blanket allow in the user's own host config does not lift the agent's deny (`tests/integration/opencode-v1-isolation.test.ts:308-318`). | A string `tools:` line is dropped by the converter and restricts nothing. A headless run auto-rejects reads outside the project: see [the v1 headless external-directory rejection](../integration-issues/opencode-v1-headless-external-directory-auto-reject-2026-11-09.md). |
| OpenCode v2 | A plugin `execute.before` allowlist, because a session allow overrides the agent's deny: see [the v2 session-allow override](../integration-issues/opencode-v2-session-allow-overrides-agent-deny-2026-11-09.md). | Do not generalize a v1 result to v2, or the reverse. |
| Pi | `tools:` is a case-sensitive allowlist. Write `Read, Grep, Glob`; they reach `createAgentSession` as `read`, `grep` and `find` (`tests/unit/pi-delegate-session.test.ts:603-616`). | A lowercase value makes `buildAgentCatalog` throw `Unknown declared tool "read"` for the whole catalog (`tests/unit/pi-delegate-session.test.ts:641-654`); `resolveToolAllowlist` raises it (`src/lib/agent-resolver.ts:221-246`). A definition with no `tools:` line gets five default tools including `systematic_search` (`src/lib/agent-resolver.ts:188-194`, `DEFAULT_READONLY_TOOLS`), so a read-only agent must declare `tools:`. |
| Claude Code | Lead with the positive `tools: Read, Grep, Glob` allowlist and treat `disallowedTools` as a second layer. Upstream reports describe `disallowedTools` not being enforced for plugin and subagent Bash; they were cited from research and not re-checked. | `claude plugin validate` checks a directory of agents only when the directory is literally named `agents`; any other name is read as a plugin root. It is a parse check only, and an agent whose frontmatter fails to parse does not get its limits (`tests/unit/connect-host-isolation.test.ts:135-163`). |

**Assert what reaches the host, not the mock.** For Pi, assert the `tools` that reach `createAgentSession`, as the test above does. The delegate is also capped at 20 turns (`src/lib/pi-delegate-tool.ts:25`, `MAX_DELEGATE_TURNS`), so any per-run bound has to fit the cap: at three orienting turns plus two per rule, eight rules per family is 19 turns (`src/lib/connect-evidence.ts:41-68`, `CONNECT_BOUNDS`).

**Manual evidence has a shape.** The Claude Code row rests on a recorded manual run with a live model, which a scripted model cannot reproduce. The entry records the exact version (`claude --version` prints `2.1.319 (Claude Code)`; the skill sends only the version token), the two runs (a dispatched subagent and a direct `--agent` session), the checker lines, a verdict, and the limits: one model on one version, the denial in the dispatched run is the subagent's own report, and whether a dispatched subagent can reach its parent's MCP tools was not tested (`HARNESSES.md:301`, entry CN-5).

## Why This Matters

A table of supported hosts is read as a guarantee. If "listed" means "the frontmatter looks right", the guarantee is false on exactly the host where the frontmatter does nothing, and nothing in the table says so. Tying every row to a named observation, and making the table's own test fail when the observation goes missing, keeps the claim as strong as the evidence. State the strength of that evidence next to the row.

## When to Apply

- Adding a row to `HOST_SUPPORT_TABLE`, or a host-claim anywhere in `HARNESSES.md`.
- Writing a proof for a deny, or reviewing one: ask which agent file ran, whether a control fails by name, and whether the child was reached.
- Shipping a new bundled agent that must stay read-only on a harness.

## Examples

A manual-evidence row, as stored:

```ts
{
  host: 'claude-code',
  version: '2.1.319',
  observedBy: 'HARNESSES.md > CN-5',
}
```

Unlisted versions (after normalization) are refused headlessly and need interactive consent.

## Related

- [On OpenCode v2 a session-level allow overrides an agent's deny](../integration-issues/opencode-v2-session-allow-overrides-agent-deny-2026-11-09.md)
- [Cross-harness `tools:` frontmatter divergence](../integration-issues/cross-harness-tools-frontmatter-divergence-2026-08-16.md)
- [Host-contract evidence is CI-owned](../workflow-issues/host-contract-evidence-is-ci-owned-2026-09-04.md): which CI jobs run the real-host suites.
- [Prove a dispatched subagent reached a plugin tool on a real host](prove-a-dispatched-subagent-reached-a-plugin-tool-on-a-real-host-2026-10-31.md)
