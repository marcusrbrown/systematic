---
title: Workflow guard digests collapsed long values, and large operation arguments disabled the guard
date: 2026-10-14
category: logic-errors
module: workflow-guard
problem_type: logic_error
component: development_workflow
symptoms:
  - "In an active epoch, a write, edit or apply_patch with arguments over 8192 characters made the guard unavailable with cause operation-input-invalid"
  - "Argument sets between 1025 and 8192 characters shared one fingerprint, so a rewrite between the before-hook and after-hook went undetected"
  - "A remote check or review state change behind a long declared resource did not mark receipts stale"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [workflow-guard, receipt-ledger, digest-collapse, fail-open, size-limit, args-fingerprint, stable-serialize]
status: superseded
superseded_by: docs/solutions/best-practices/workflow-guard-removed-2026-10-19.md
superseded_date: 2026-10-19
---

> **Superseded (2026-10-19):** the workflow guard this learning describes was removed ([#1153](https://github.com/marcusrbrown/systematic/issues/1153)); see [the decision note](../best-practices/workflow-guard-removed-2026-10-19.md). The body below is preserved as history.

# Workflow guard digests collapsed long values, and large operation arguments disabled the guard

## Problem

Two size limits on the guard's comparison path made large operation arguments disable the guard and made long values compare equal. Fixed in #1119 (issue #1113).

## Symptoms

- In an active epoch, a `write`, `edit` or `apply_patch` whose arguments exceeded 8192 characters made the guard `unavailable` with `operation-input-invalid`. Unavailable is terminal, so no further receipts could be minted.
- Every argument set from 1025 to 8192 characters produced the same fingerprint. A rewrite of the arguments between `tool.execute.before` and `tool.execute.after` was not detected.
- `stateFingerprint` joined remote state fields with `|` and digested the result. With a declared resource near 1024 characters, a check-state change from success to pending did not mark the receipt stale.

## What Didn't Work

- **Pre-hashing the arguments in the guard only.** Review found the same collapse in `stateFingerprint`, so a guard-side fix would have left the remote state comparison failing open. The fix moved into the ledger, where every comparison passes.
- **Testing a long push composite.** `<resource>:<revision>` over 1024 characters is unreachable: `parseContext` bounds context identities when a receipt is minted, so that path already fails closed. For the same reason no stored receipt or marker ever held a collapsed digest, and nothing needed migration.
- **Testing a `|` boundary shift in `stateFingerprint`.** Every shift that the old join collapsed also changes an identity the guard compares on its own, so no public-API test can isolate the encoding. The JSON encoding stays as defense in depth.

## Solution

`digestIdentity` in `src/lib/receipt-ledger.ts` reused `normalizedIdentity`, which bounds parsed and stored identities at `MAX_IDENTITY_LENGTH` (1024) and returns `undefined` above it. The digest path then hashed the sentinel `'invalid'`.

Before (excerpt; the function is nested in `createReceiptLedger` and closes over the session salt):

```ts
function digestIdentity(domain: DigestDomain, identity: string): string {
  const normalized = normalizedIdentity(identity)
  if (!normalized || !DIGEST_DOMAIN_SET.has(domain)) {
    return digestReceiptIdentity(domain, 'invalid', sessionSaltBytes)
  }
  return digestReceiptIdentity(domain, normalized, sessionSaltBytes)
}
```

After:

```ts
function digestIdentity(domain: DigestDomain, identity: string): string {
  // Hashing has no length bound: MAX_IDENTITY_LENGTH only limits identities
  // that are parsed or stored, and a bound here would make every longer
  // value compare equal.
  // identity is typed string; the typeof check guards untyped runtime callers.
  const trimmed = typeof identity === 'string' ? identity.trim() : ''
  if (!trimmed || !DIGEST_DOMAIN_SET.has(domain)) {
    return digestReceiptIdentity(domain, 'invalid', sessionSaltBytes)
  }
  return digestReceiptIdentity(domain, trimmed, sessionSaltBytes)
}
```

The other changes:

- `stateFingerprint` in `src/lib/workflow-guard.ts` digests `JSON.stringify` of its field list instead of a `|` join.
- `stableSerialize` in `src/lib/opencode-workflow-guard.ts` has no size budget and keeps its depth limit of 8. It returns `undefined`, which records `operation-input-invalid`, for objects that are not plain records (`Date`, `Map`, `Set`, class instances) and for own symbol keys on records and arrays. Before, those serialized as `{}` or dropped the symbol key, so different values could share a fingerprint.
- `argsFingerprint` validates the original arguments before canonicalization, for every tool. `apply_patch` canonicalization spreads the arguments and each hunk into fresh plain objects, which would otherwise launder a class-instance hunk or a non-enumerable symbol property.

Two limits remain. An object whose prototype is itself a null-prototype object passes the plain-object check, and its inherited keys are not fingerprinted. Nothing bounds the size of the fingerprint input, and tests cover arguments up to 64 KiB. Host tool arguments are parsed JSON, so neither limit is reachable through a tool call.

## Why This Works

A cap that substitutes a sentinel makes distinct values compare equal, and on a comparison path that fails open. Removing the cap from the hashing path lets long values digest in full. Identities of 1024 characters or fewer keep byte-identical digests, so live receipts and markers still validate. Empty, whitespace-only, non-string and unknown-domain input still digest `'invalid'`. The parse-and-store bound is unchanged, which is where a length limit actually means something.

Reverting only the ledger change makes the 64 KiB last-character rewrite test fail, so both the serializer and the ledger fix are needed.

## Prevention

- Put a size cap on the evidence it bounds, at parse or store time, never on a shared comparison or digest path.
- A cap that returns a sentinel collapses distinct values. Reject the input or hash it in full.
- Test long values that differ only in their last character, past every limit that exists today (excerpt from `tests/unit/receipt-ledger.test.ts`):

  ```ts
  test.each(['call', 'resource'] as const)(
    'distinguishes %s identities over 1024 characters that differ only at the end',
    (domain) => {
      const prefix = 'x'.repeat(1999)
      expect(ledger.digestIdentity(domain, `${prefix}a`)).not.toBe(
        ledger.digestIdentity(domain, `${prefix}b`),
      )
    },
  )
  ```

- Pin short-identity digests against `digestReceiptIdentity` with the session salt, so a future change can't silently invalidate live receipts.
- When a value is canonicalized before it is fingerprinted, validate the original first.

## Related Issues

- #1113, #1119
- `docs/solutions/integration-issues/workflow-guard-skipped-skills-over-32kb-2026-09-26.md`: the same rule (a cap belongs on the evidence it bounds) applied to skill activation.
