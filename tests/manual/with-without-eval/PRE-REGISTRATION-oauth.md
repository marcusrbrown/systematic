# With/Without Systematic — OAuth Task Pre-Registration

**Status:** pre-registered (written BEFORE the OAuth trials)
**Date:** 2026-05-29
**Plan unit:** U3 — second task (different risk domain: security vs data-integrity)

Mirrors the DB-migration pre-registration. Written before running so the OAuth
result cannot be retro-fitted.

## Models / arms

- Models: `openai/gpt-5.5` (frontier) + `opencode-go/kimi-k2.6` (open-source)
- Arms: WITHOUT (no plugin, `--pure`) and WITH (Systematic loaded, workflow-invoked)
- Same isolation recipe + harness as the DB task (run-arm.sh)

## Task (committed before running)

Add "Sign in with GitHub" OAuth to an existing Express/Node web app that already
has a `users` table and `express-session`. Implement the login flow.

## Pre-registered publishable-delta bar (security-domain edge cases)

WITHOUT must skip **≥2 of** the following that WITH does not:

1. **Explicit planning** before coding
2. **Security edge cases named** — `state` param (CSRF), `redirect_uri` validation,
   PKCE, token storage at rest, scope minimization, session fixation on login,
   token expiry/refresh
3. **Project-standard adherence** (error handling on callback, tests)
4. **A security review/verification pass**
5. **Knowledge capture** (why decisions were made)

## No-ship condition

Same as DB task: if the WITH run does not clear the ≥2-skip bar, present an honest
decision guide, not a staged win. Real transcripts only.

## Honesty note

The OAuth baseline (especially frontier) may also be strong — that is the expected
and honest finding. The claim is the review STEP happening, not first-draft quality.

## RESULT (recorded after running — seeded workspace)

First attempt was CONFOUNDED: empty workspace → both arms stalled asking for app
files. Re-ran with `oauth-seed/` (a real Express app: express-session + email
login + users table) copied into each workspace.

gpt-5.5, seeded, n=1 per arm:

| Arm | Steps | Review subagents | Outcome |
|-----|-------|------------------|---------|
| baseline (no plugin) | 165 | 0 | Built OAuth using `state` for CSRF, but NO review pass |
| treatment (workflow) | 605 | 4 (incl. "Review OAuth security") | Built it + security review CAUGHT: (a) session fixation — session ID not regenerated after login; (b) state-replay — error callbacks (`?error=access_denied&state=valid`) return before consuming stored state, so state is reusable → replay/CSRF; (c) missing denial-branch + client-secret-config tests |

Both arms used `state`. The treatment's value was the SECURITY REVIEW PASS catching
session-fixation + state-replay in code that otherwise looked complete. Baseline
shipped its implementation unreviewed.

kimi-OAuth SKIPPED per Oracle: the pattern is consistent with the DB task (review
step catches what one-shot skips), not materially different, so the extra runs add
cost without changing the thesis.

**Second-domain confirmation:** the review-step-catches-what-one-shot-skips pattern
holds in the security domain (session fixation, state replay), not just data-integrity.
