---
title: Queue writes need idempotency keys before any retry
applies_when:
  - a producer retries a failed queue write
---

## Guidance

A blind retry of a queue write duplicates the message when the first attempt actually landed. Attach an idempotency key to every message before the first send, and retry only with the same key.

## Prevention

Reject any producer code path that retries a send without a stable idempotency key.
