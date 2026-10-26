# YAML Frontmatter Schema

`schema.yaml` in this directory is the canonical contract for `docs/solutions/` frontmatter written by `systematic:ce-compound`.

Use this file as the quick reference for:
- required fields
- enum values
- validation expectations
- category mapping
- track classification (bug vs knowledge)

## Tracks

The `problem_type` determines which **track** applies. Each track has different required and optional fields.

| Track | problem_types | Description |
|-------|--------------|-------------|
| **Bug** | `build_error`, `test_failure`, `runtime_error`, `performance_issue`, `database_issue`, `security_issue`, `ui_bug`, `integration_issue`, `logic_error` | Defects and failures that were diagnosed and fixed |
| **Knowledge** | `best_practice`, `documentation_gap`, `workflow_issue`, `developer_experience`, `architecture_pattern`, `design_pattern`, `tooling_decision`, `convention` | Practices, patterns, workflow improvements, and documentation |

Prefer the narrowest applicable value. `best_practice` is the fallback when no narrower knowledge-track value fits.

- `architecture_pattern` — structural decisions about how components relate
- `design_pattern` — reusable solutions to recurring design problems
- `tooling_decision` — choices about tools, libraries, or build infrastructure
- `convention` — agreed-upon naming, formatting, or style rules

## Required Fields (both tracks)

- **module**: Module or area affected
- **date**: ISO date in `YYYY-MM-DD`
- **problem_type**: One of the values listed in the Tracks table above
- **component**: One of `backend`, `frontend`, `api`, `database`, `background_job`, `authentication`, `infrastructure`, `configuration`, `dependencies`, `tooling`, `development_workflow`, `testing_framework`, `documentation`, `assistant`
- **severity**: One of `critical`, `high`, `medium`, `low`

## Bug Track Fields

Required:
- **symptoms**: YAML array with 1-5 observable symptoms (errors, broken behavior)
- **root_cause**: One of `missing_include`, `missing_index`, `wrong_api`, `scope_issue`, `thread_violation`, `async_timing`, `memory_leak`, `config_error`, `logic_error`, `test_isolation`, `missing_validation`, `missing_permission`, `missing_workflow_step`, `inadequate_documentation`, `missing_tooling`, `incomplete_setup`
  - `missing_include` is a missing eager load or an N+1 query. `wrong_api` is an API used in a way that does not fit the situation.
- **resolution_type**: One of `code_fix`, `migration`, `config_change`, `test_fix`, `dependency_update`, `environment_setup`, `workflow_improvement`, `documentation_update`, `tooling_addition`

## Knowledge Track Fields

Applies to every knowledge-track `problem_type` listed in the Tracks table above.

No additional required fields beyond the shared ones. All fields below are optional:

- **applies_when**: Conditions or situations where this guidance applies
- **symptoms**: Observable gaps or friction that prompted this guidance
- **root_cause**: Underlying cause, if there is a specific one
- **resolution_type**: Type of change, if applicable

## Optional Fields (both tracks)

- **related_components**: Other components involved
- **tags**: Search keywords, lowercase and hyphen-separated
- **title**: Human-readable title of the learning
- **environment**: Runtime, platform, or toolchain the learning applies to (free text)
- **category**: Directory name under `docs/solutions/` the doc is filed in (see Category Mapping)
- **last_updated**: Date the doc was last edited, `YYYY-MM-DD`
- **last_refreshed**: Date the doc was last verified against the codebase, `YYYY-MM-DD`

## Lifecycle Fields (both tracks, optional)

- **status**: One of `active`, `stale`, `superseded`. A missing `status` means `active`. An explicit empty value is invalid.
- **superseded_by**: Repo-root path of the doc that replaces this one, for example `docs/solutions/best-practices/example.md`. Required when `status` is `superseded`. The target must be an existing doc under `docs/solutions/` (not `README.md`) that is not itself superseded. A bare filename or any other path form does not resolve.
- **superseded_date**: Date the doc was superseded, `YYYY-MM-DD`
- **stale_reason**: Why the doc is marked stale. Present only while `status` is `stale`.
- **stale_date**: Date the doc was marked stale, `YYYY-MM-DD`. Present only while `status` is `stale`.

Writers keep these fields consistent. Updating or verifying a doc clears `status: stale` together with `stale_reason` and `stale_date`. Nothing writes `status: superseded`: superseding is a manual edit. A `superseded_by` on a doc that is not superseded is ignored.

## Optional Fields (bug track only, legacy)

- **rails_version**: Legacy. Rails version in `X.Y.Z` format. Preserved on existing bug-track docs, never offered to writers. Documentation only: the validator does not check it.

## Backward Compatibility

Docs created before the track system may have `symptoms`/`root_cause`/`resolution_type` on knowledge-type problem_types. These are valid legacy docs:

- Bug-track fields present on a knowledge-track doc are harmless. Do not strip them during refresh unless the doc is being rewritten for other reasons.
- When creating **new** docs, follow the track rules above.

## Legacy Values

Older docs may carry Rails and product-specific values. Validators and refresh accept them, update paths preserve them and never rewrite them, and writers are never offered them. Only new docs read the offered values above.

| Field | Legacy values |
|-------|---------------|
| `component` | `rails_model`, `rails_controller`, `rails_view`, `service_object`, `frontend_stimulus`, `hotwire_turbo`, `email_processing`, `brief_system`, `payments` |
| `root_cause` | `missing_association` |
| `resolution_type` | `seed_data_update` |

`schema.yaml` lists these under `legacy_values`, beside `values`, on the bug-required and knowledge-optional lists alike.

## Category Mapping

- `build_error` -> `docs/solutions/build-errors/`
- `test_failure` -> `docs/solutions/test-failures/`
- `runtime_error` -> `docs/solutions/runtime-errors/`
- `performance_issue` -> `docs/solutions/performance-issues/`
- `database_issue` -> `docs/solutions/database-issues/`
- `security_issue` -> `docs/solutions/security-issues/`
- `ui_bug` -> `docs/solutions/ui-bugs/`
- `integration_issue` -> `docs/solutions/integration-issues/`
- `logic_error` -> `docs/solutions/logic-errors/`
- `developer_experience` -> `docs/solutions/developer-experience/`
- `workflow_issue` -> `docs/solutions/workflow-issues/`
- `best_practice` -> `docs/solutions/best-practices/`
- `documentation_gap` -> `docs/solutions/documentation-gaps/`
- `architecture_pattern` -> `docs/solutions/best-practices/`
- `design_pattern` -> `docs/solutions/best-practices/`
- `tooling_decision` -> `docs/solutions/best-practices/`
- `convention` -> `docs/solutions/best-practices/`

The four narrower knowledge-track types share the `best-practices/` directory rather than each
getting their own. That matches where such docs are already filed, and avoids single-document
directories that fragment search.

## Validation Rules

1. Determine the track from `problem_type` using the Tracks table.
2. All shared required fields must be present.
3. Bug-track required fields (`symptoms`, `root_cause`, `resolution_type`) must be present on bug-track docs.
4. Knowledge-track docs have no additional required fields beyond the shared ones.
5. Bug-track fields on existing knowledge-track docs are harmless (see Backward Compatibility).
6. Enum fields must match the allowed values exactly. Legacy values are accepted too (see Legacy Values).
7. Array fields must respect min/max item counts.
8. `date` must match `YYYY-MM-DD`.
9. `status`, if present, must be `active`, `stale` or `superseded`.
10. A `superseded` doc must carry a `superseded_by` that names an existing doc which is not itself superseded.
