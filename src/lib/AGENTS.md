# src/lib — Core Implementation

Modules implementing plugin logic: discovery, config, schema validation, harness adapters, and receipt-backed workflow enforcement.

## Data Flow

```
loadConfig() → createConfigHandler() → {
  findSkillsInDir()  → loadSkillAsCommand()  → OpenCode config
  findAgentsInDir()  → loadAgentAsConfig()   → OpenCode config
  findCommandsInDir() → loadCommandAsConfig() → OpenCode config
}

createSkillTool() → buildSkillToolDescription()/buildSkillToolParameterHint()/buildSkillContentOutput()/resolveSkill() → OpenCode tool
getBootstrapContent() → reads using-systematic SKILL.md → system prompt
createOpencodeWorkflowGuard() → OpenCode hooks/tools → operation observer + receipt classifier/ledger/readback → guarded transitions
buildCapabilitySnapshot() → normalized capability/config-observation snapshot → CLI output
pi-subagents lifecycle → generate personas → transactional export/refresh/cleanup → Pi agents directory
```

All discovery follows same pattern: `dir → walkDir() → find files → parseFrontmatter() → typed array`

## Modules

### Discovery Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `walk-dir.ts` | `walkDir`, `WalkEntry`, `WalkOptions` | Recursive dir walker with depth + category tracking |
| `skills.ts` | `findSkillsInDir`, `SkillInfo`, `SkillFrontmatter` | Skill discovery (maxDepth, frontmatter extraction) |
| `agents.ts` | `findAgentsInDir`, `AgentInfo`, `AgentFrontmatter` | Agent discovery (category from subdir name) |
| `commands.ts` | `findCommandsInDir`, `CommandInfo`, `CommandFrontmatter` | Command discovery |
| `frontmatter.ts` | `parseFrontmatter`, `formatFrontmatter`, `stripFrontmatter` | YAML frontmatter parse/format/strip |
| `discovered-skills.ts` | `discoverSkills`, `DiscoveredSkill`, `DiscoverSkillsOptions` | Last-write-wins discovery of user/project skills across external and OpenCode config roots; reports bounded source issues |

### Loading Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `skill-loader.ts` | `loadSkill`, `LoadedSkill` | Loads + wraps skill content in XML template |
| `skill-resolver.ts` | `resolveSkill`, `buildSkillToolDescription`, `buildSkillToolParameterHint`, `buildSkillContentOutput`, `discoverSkillFiles` | Harness-neutral skill resolution, wrapped output, and catalog helpers shared by both adapters |
| `agent-resolver.ts` | `buildAgentCatalog`, `resolveAgent`, `renderAgentCatalogCompact`, `resolveToolAllowlist`, `DEFAULT_READONLY_TOOLS` | Harness-neutral, in-memory runtime catalog built from packaged `agents/<category>/<name>.md` (category dropped from the lookup key, duplicate names fail-closed); parses each persona's `tools:` frontmatter value into a least-privilege Pi tool allowlist, validated at catalog-build time so unknown/denylisted tools fail closed with source-path context |
| `skill-catalog.ts` | `buildCatalogEntries`, `renderCatalogCompact`, `CatalogEntry`, `CatalogOptions` | Builds the filtered bundled-skill catalog used in tool descriptions, excluding disabled and model-invocation-disabled skills |
| `validation.ts` | `isAgentMode`, `isPermissionSetting`, `normalizePermission`, `extractString`, `extractBoolean` | Agent config extraction + type guards + safe value extraction |

### Config & Integration Layer

| Module | Key Exports | Role |
|--------|-------------|------|
| `config.ts` | `loadConfig`, `getConfigPaths`, `SystematicConfig`, `DEFAULT_CONFIG` | JSONC config loading + merging |
| `config-schema.ts` | `SystematicConfigSchema`, `validateConfig`, `SECURITY_OVERLAY_FIELDS`, `AgentOverlaySchema`, `CategoryOverlaySchema`, `BootstrapSchema` | Canonical Zod schema for user config; security field list |
| `agent-overlays.ts` | `buildBundledAgentInventory`, `validateAgentOverlays`, `resolveAgentOverlaySet` | Discovers bundled agent/category targets, validates user overlays against the strict schemas and enabled-skill set, and indexes validated overlays for runtime lookup |
| `routing-resolver.ts` | `resolveRouting`, `qualifierResolvesWithoutModel`, `collectWrittenLegacyPiSubagentsThinkingWarnings`, `toSourcedOverlayMap`, `toSourcedPiSubagentsOverlays`, `RoutingTarget`, `RoutingResolution` | Pure per-target/harness routing precedence (agent block > agent flat > category block > category flat) for `model` and the opencode `variant` / pi `thinking` qualifier, with legacy `pi_subagents.thinking` fallback; backs the loader's post-merge qualifier-requires-model check; the legacy-deprecation warning collector dedupes by the WRITTEN `pi_subagents.<scope>.<key>` field, one warning per field regardless of how many agents it resolves for; also exports the shared plain-overlay-map → `SourcedOverlayConfigMap` shape adapter used by the Pi delegate tool and Pi persona export |
| `bundled-names.ts` | `BUNDLED_AGENT_NAMES`, `BUNDLED_AGENT_QUALIFIED_IDS`, `BUNDLED_SKILL_NAMES`, `BundledAgentName`, `BundledSkillName` | Generated typed inventory of bundled agent and skill names; regenerate rather than editing by hand |
| `capability-snapshot.ts` | `CapabilityFactInput`, `ConfigObservationMetadata`, `buildCapabilitySnapshot`, `serializeCapabilitySnapshot` | Validates, canonicalizes, sorts, and serializes the read-only capability/config-observation snapshot emitted by the CLI |
| `removed-names.ts` | `REMOVED_BUNDLED_SKILL_NAMES`, `REMOVED_BUNDLED_AGENT_NAMES`, `REMOVED_BUNDLED_AGENT_CATEGORIES` | Compatibility allowlists for bundled names removed from the catalog; strict config validation warns-and-ignores these without accepting arbitrary unknown names |
| `review-artifact-schema.ts` | `ReviewArtifactSchema`, `ReviewArtifact`, `InputFindingSchema`, `REVIEW_ARTIFACT_CUSTOM_MESSAGES`, `DispatchOutcomeSchema`, `DispositionSchema`, `HarnessSchema` | Canonical Zod source of truth for the `ce:review` run-level `review-summary.json` artifact. Generates the committed JSON Schema at `skills/ce-review/references/review-summary-schema.json` via `scripts/generate-review-artifact-schema.ts`, and backs the `systematic validate-review-artifact` CLI command. `input_findings` is a discriminated union on `record_type` so admitted rows and rejected-payload summaries stay machine-separable; `superRefine` carries the two invariants JSON Schema cannot express, using the exported message constants so the CLI's output allowlist can safely print them |
| `review-artifact-path.ts` | `ArtifactPathResult`, `ReadArtifactResult`, `ValidateReviewArtifactArguments`, `ALLOW_OUTSIDE_ARTIFACT_ROOT_FLAG`, `VALIDATE_REVIEW_ARTIFACT_USAGE`, `parseValidateReviewArtifactArguments`, `hasParentDirectoryTraversal`, `pathContainsSymlink`, `resolveReviewArtifactPath`, `readReviewArtifact`, `isLegacyReviewArtifact`, `formatReviewArtifactIssuePath`, `formatReviewArtifactSuccessMessage` | Shared review-artifact CLI argument parsing (including the idempotent `--allow-outside-artifact-root` flag), path containment, JSON reading, legacy detection, validation-issue projection, and success-message formatting for the CLI and Claude Code validator entry, so the two entries stay structurally identical rather than hand-maintained copies |
| `agent-colors.ts` | `isValidAgentColor`, `OPENCODE_AGENT_COLOR_TOKENS` | Color validator (hex or named token) + accepted token enum |
| `config-handler.ts` | `createConfigHandler`, `ConfigHandlerDeps`, `formatAgentDescription`, `toTitleCase` | OpenCode config hook (collects + emits all assets) |
| `skill-tool.ts` | `createSkillTool`, `SkillToolOptions` | OpenCode `systematic_skill` adapter (tool wiring, permission/metadata side effects, execution bridging) |
| `bootstrap.ts` | `getBootstrapContent`, `applyBootstrapContent`, `computeBootstrapContentSafe`, `composeSystemPromptWithBootstrap`, `INTERNAL_AGENT_SIGNATURES`, `BootstrapDeps` | System prompt injection (using-systematic skill); harness-neutral safe-compute/compose helpers reused by Pi's `before_agent_start` |
| `pi-delegate-tool.ts` | `createPiDelegateTool`, `MAX_DELEGATE_TURNS`, `DELEGATE_TOOL_NAME`, `DELEGATE_EXECUTION_MODE`, `DelegateSessionLike`, `CreateDelegateSession` | Pi `systematic_delegate` tool factory: `{agent, task}`-only schema, fail-closed validation (unknown persona/model/tool/re-entry) before any session is created, fixed 20-turn cap enforced via `session.subscribe()` + `abort()`, `AbortSignal` propagation, unsubscribe/dispose in `finally`. Depends on Pi session construction only through the injectable `CreateDelegateSession` seam (no live Pi SDK import), so it is unit-testable without a real Pi session/provider |
| `pi-delegate-session.ts` | `createRealPiDelegateSession` | The real `CreateDelegateSession` implementation: `DefaultResourceLoader` with `noExtensions: true` (depth 1) plus every other resource category suppressed, `systemPromptOverride` replacing the prompt with the persona body, `SessionManager.inMemory()`, `reload()` before session creation. The only module that statically imports the live Pi SDK for delegation |
| `setup.ts` | `setupHarness`, `isSetupError`, `Harness`, `SetupResult`, `PI_PACKAGE_IDENTIFIER`, `SYSTEMATIC_PACKAGE_NAME` | Backs `systematic setup --harness opencode\|pi` (`src/cli.ts`): project-local-only, single-trusted-read + atomic-no-clobber-backup writes to either OpenCode's singular `plugin` array (v1.17.6 schema; `plugins`/duplicate-keys rejected) or `.pi/settings.json`'s `packages` array (structural JSONC edit, filter-aware tagged-entry idempotency); never touches the other harness's config; discriminated `SetupResult` (`'configured' \| 'already-configured'`), plain-Error `isSetupError()` marker (no custom class) |

### Pi Integration

| Module | Key Exports | Role |
|--------|-------------|------|
| `pi-subagents-personas.ts` | `CURATED_PERSONAS`, `sanitizeName`, `classifyCompatibility`, `generatePersonaContent`, `generatePersonaManifest`, `generateAll` | Pure curated-persona screening and content/manifest generation for pi-subagents; excludes critical Systematic-coupled personas and marks optional integrations as warnings |
| `pi-subagents-export.ts` | `resolveAgentsRoot`, `resolveAnchor`, `readManifestStrict`, `readManifest`, `writeManifest`, `preview`, `exportPersonas`, `refresh`, `cleanup`, `runWithRollback`, `MANIFEST_FILENAME`, `LOCK_FILENAME` | Scope-aware, locked and transactional Pi persona export lifecycle; validates manifest/path ownership and rolls back failed mutations |

### Workflow Guard & Receipt Evidence

| Module | Key Exports | Role |
|--------|-------------|------|
| `opencode-operation-observer.ts` | `createOpencodeOperationObserver`, `validateRegisteredWorktree`, `OperationObserverResult`, `OperationObserverRemoteResult` | Bounded local/remote Git and filesystem evidence snapshots, including worktree registration validation, for guarded operation readback |
| `opencode-workflow-guard.ts` | `createOpencodeWorkflowGuard`, `createWorkflowGuardBlockedError`, `isWorkflowGuardBlockedError`, `SYSTEMATIC_WORKFLOW_RECEIPT_METADATA_KEY`, `OpencodeWorkflowGuard` | OpenCode adapter that exposes guarded workflow tools and hooks, persists/reconstructs receipt markers, and fails closed when operation evidence or host readback is unavailable |
| `receipt-classifier.ts` | `createReceiptClassifier`, `parseReceiptOperationAfter`, `parseReceiptOperationObservation`, `ReceiptClassifier`, `ReceiptOperationObservation` | Parses tool-operation observations and classifies safe shell/non-shell commands into receipt operations with terminal and evidence outcomes |
| `receipt-ledger.ts` | `createReceiptLedger`, `isLocalOperation`, `ReceiptLedger`, `ReceiptEnvelope`, `ReceiptClassification` | In-memory lifecycle for preparing, finalizing, validating, consuming, and recovering integrity-checked operation receipts |
| `receipt-readback.ts` | `validateReceiptMarker`, `filterMarkersByRegistration`, `extractReceiptReadbackSeed`, `foldReceiptReadback`, `projectReceiptMintMarker`, `projectReceiptConsumptionMarker`, `projectReceiptProgressionMarker`, `receiptReadbackExpectationFromMetadata`, `digestReceiptIdentity` | Validates authenticated receipt/progression markers and folds persisted markers into recoverable receipt and workflow state |
| `workflow-guard.ts` | `createWorkflowGuard`, `WorkflowGuard`, `WorkflowStatus`, `WorkflowGuardOptions`, `WorkflowReasonCode` | Core receipt-backed state machine: activates epochs, starts units, records evidence, enforces transitions, handles recovery, and supports explicit guard modes |
| `question-attestation.ts` | `CANONICAL_QUESTION_WORDING`, `classifyQuestionAnswer`, `createQuestionAttestation`, `QuestionAttestationMachine`, `QuestionAttestation` | Challenge/bind/reply/reject/consume state machine for authenticated user confirmation of guarded transitions |

## Module table exclusions

No `src/lib` modules are intentionally excluded from these tables.

## Key Types

- **Discovery:** `SkillInfo`, `AgentInfo`, `CommandInfo`, `WalkEntry` — all have `name` + path/file fields
- **Config:** `SystematicConfig` (disabled lists + bootstrap), `ConfigHandlerDeps` (directory paths), validated agent/category overlays, and capability observations
- **Workflow evidence:** `ReceiptEnvelope`, `ReceiptClassification`, `ReceiptReadbackState`, `WorkflowStatus` — typed contracts for observed operations, persisted markers, and guarded progression

## Patterns

- **Function-only**: Zero classes. All modules export factory functions or pure helpers
- **Interface-first**: Data shapes defined as interfaces, logic as functions
- **Null returns**: Non-critical failures return `null`/`undefined` (not throws)
- **Type guards**: `validation.ts` provides safe extraction from `unknown` frontmatter data
- **Const enums**: `AgentMode`, `PermissionSetting` for compile-time safety
- **Fail-closed evidence**: receipt and marker parsers reject malformed, foreign, stale, or unauthenticated state rather than guessing

## Notes

- `parseFrontmatter` is the most-imported function across the codebase
- `walkDir` is the foundation layer, used by all three discovery modules
- `findSkillsInDir` is the highest-centrality discovery function across the loading layer
- `SKILL_PREFIX` = `'systematic:'` — all skills registered with this prefix
- `parseFrontmatter` is regex-based (not a YAML library for delimiter detection)
- `formatFrontmatter` uses `js-yaml` dump with `noRefs` and core schema
- `config-handler.ts` contains internal `loadAgentAsConfig`/`loadCommandAsConfig`/`loadSkillAsCommand` — the glue between discovery and OpenCode config output
- The workflow guard is OpenCode-only; Pi has the delegate/export integration but no runtime receipt guard
- Receipt markers are authenticated and registration-scoped; do not treat persisted host metadata as trusted until `receipt-readback.ts` validates it
