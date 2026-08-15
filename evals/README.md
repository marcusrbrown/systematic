# Local OpenCode evals

Direct invocation:

```sh
bun scripts/run-evals.ts \
  --case bootstrap-loading \
  --case fixture-local-write \
  --mode source \
  --mode installed \
  --seed local-seed-001 \
  --clock 2026-08-14T00:00:00.000Z
```

`--case` and `--mode` are repeatable. Valid cases are `bootstrap-loading` and
`fixture-local-write`; valid modes are `source` and `installed`. Seeds match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` and clocks are exact UTC timestamps in
`YYYY-MM-DDTHH:mm:ss.sssZ` form. Use `--help` for the concise CLI contract.

Local output is written under `evals/runs/<runId>/`.
`manifest.json` is written last and is the completion marker. Exit code `0`
means every requested selection succeeded, `1` means a completed or partial
run contains a non-success outcome, and `2` means invalid CLI arguments.

The four primary outcomes are `success`, `infra_failure`, `task_failure`, and
`privacy_cleanup_failure`.

Persisted output is allowlisted and privacy-checked. Raw stdout, stderr,
transcripts, environment values, repository content, user prose, secrets, and
absolute paths are outside the persistence boundary.

Isolation is fixture-scoped local isolation, not operating-system isolation.

Unsupported scope includes Pi or Claude Code, additional cases, networked or
credentialed tasks, hosted execution, and CI orchestration.
