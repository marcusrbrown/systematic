# Document Review Output Template

Use this **exact format** when presenting synthesized review findings. Findings are grouped by severity, not by reviewer.

**IMPORTANT:** Use pipe-delimited markdown tables (`| col | col |`). Do NOT use ASCII box-drawing characters.

## Example

```markdown
## Document Review Results

**Document:** docs/plans/2026-03-15-feat-user-auth-plan.md
**Type:** plan
**Reviewers:** coherence, feasibility, security-lens, scope-guardian
- security-lens -- plan adds a public API endpoint with an auth flow
- scope-guardian -- plan has 15 requirements across 3 priority levels

Applied 2 fixes. 4 items need attention (2 errors, 2 omissions). 1 FYI observation.

### Applied fixes

- Corrected the stale cross-reference from Section 3.2 to Section 3.1 (coherence, confidence 100)
- Updated the unit count from 6 to 7 to match the listed units (feasibility, confidence 100)

### P0 -- Must Fix

#### Errors

**Decisions**

| # | Section | Issue | Reviewer | Confidence |
|---|---------|-------|----------|------------|
| 1 | Requirements Trace | The goal requires offline support, but the approach assumes persistent connectivity | coherence | 75 |

### P1 -- Should Fix

#### Errors

**Proposed fixes**

| # | Section | Issue | Suggested fix | Reviewer | Confidence |
|---|---------|-------|---------------|----------|------------|
| 2 | API Design | The plan claims Rails lacks native JSON error responses and proposes a custom serializer | Use Rails' existing `render json:` response path and remove the custom serializer step | feasibility | 75 |

#### Omissions

**Proposed fixes**

| # | Section | Issue | Suggested fix | Reviewer | Confidence |
|---|---------|-------|---------------|----------|------------|
| 3 | Implementation Unit 3 | The custom auth plan omits the existing Devise setup and migration path | Extend the existing Devise flow and document its migration path instead of introducing a parallel auth setup | feasibility | 100 |

### P2 -- Consider Fixing

#### Omissions

**Proposed fixes**

| # | Section | Issue | Suggested fix | Reviewer | Confidence |
|---|---------|-------|---------------|----------|------------|
| 4 | API Design | The public webhook endpoint has no rate limiting plan | Add the established request-throttling middleware to the webhook route and document its limit | security-lens | 75 |

### FYI observations

| # | Section | Observation | Reviewer | Confidence |
|---|---------|-------------|----------|------------|
| 5 | Error Handling | The plan does not say whether rate-limit responses include retry guidance | security-lens | 50 |

### Residual concerns

| # | Concern | Source |
|---|---------|--------|
| 1 | Migration rollback strategy is not addressed for Phase 2 data changes | feasibility |

### Deferred questions

| # | Question | Source |
|---|---------|--------|
| 1 | Should the API use versioned endpoints from launch? | feasibility, security-lens |

### Coverage

| Persona | Status | Findings | Fixes | Proposed fixes | Decisions | FYI observations | Residual |
|---------|--------|----------|-------|----------------|-----------|------------------|----------|
| coherence | completed | 2 | 1 | 0 | 1 | 0 | 0 |
| feasibility | completed | 3 | 1 | 2 | 0 | 0 | 1 |
| security-lens | completed | 2 | 0 | 1 | 0 | 1 | 0 |
| scope-guardian | completed | 0 | 0 | 0 | 0 | 0 | 1 |
| product-lens | not activated | -- | -- | -- | -- | -- | -- |
| design-lens | not activated | -- | -- | -- | -- | -- | -- |
```

## Section Rules

- **Summary line**: Always present after the reviewer list. Format: "Applied N fixes. K items need attention (X errors, Y omissions). Z FYI observations." Omit any zero clause. `K` counts actionable proposed fixes and decisions; FYI observations are counted separately.
- **Applied fixes**: List all fixes applied silently (`safe_auto` at confidence `100`). Include enough detail per fix to convey the substance -- especially for fixes that add content or touch document meaning. A `safe_auto` finding at confidence `75` is demoted before routing and is not silently applied. Omit section if none.
- **P0-P3 sections**: Only include sections that have findings. Omit empty severity levels. Within each severity, separate into **Errors** and **Omissions** sub-headers. Omit a sub-header if that severity has none of that type.
- **Proposed fixes**: Findings with `gated_auto` at confidence `75` or `100`. Include the concrete suggested fix and require user confirmation. Omit if none.
- **Decisions**: Findings with `manual` at confidence `75` or `100`. Include the suggested fix when one exists; otherwise present the judgment call without inventing a fix. Omit if none.
- **FYI observations**: Findings at confidence `50`, regardless of autofix class. They require no decision or action. Omit if none.
- **Residual concerns**: Unresolved residual risks that remain after restatement suppression, plus any residual items explicitly retained by synthesis. Omit if none.
- **Deferred questions**: Questions for later workflow stages. Omit if none.
- **Coverage**: Always include. All finding and route counts are **post-synthesis**. For each persona, **Findings** equals **Fixes + Proposed fixes + Decisions + FYI observations**. If deduplication merges a finding across personas, attribute it to the persona with the highest confidence anchor; if anchors tie, use document order, and reduce the other persona's finding and route counts. **Residual** remains the count of `residual_risks` from that persona's raw output, not the promoted or suppressed subset shown in Residual concerns. Failed or malformed reviewers are marked in Status and do not contribute findings.
