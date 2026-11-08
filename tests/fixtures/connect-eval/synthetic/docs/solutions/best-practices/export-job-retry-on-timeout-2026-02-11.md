---
title: Retry a timed-out export job with jittered backoff
date: 2026-02-11
category: best-practices
module: exports
problem_type: best_practice
applies_when:
  - An export job times out while waiting for the export endpoint
  - A scheduler decides whether to run a failed export job again
tags: [exports, retry, timeout, backoff]
---

# Retry a timed-out export job with jittered backoff

## Context

Export jobs call the export endpoint and wait for a download link. Most timeouts came from a busy endpoint and cleared within a minute, yet each one failed the whole scheduled batch.

## Guidance

Retry a timed-out export job up to three times with jittered exponential backoff. The export endpoint is safe to call again, and the second try almost always succeeds. Fail the job only after the third attempt.

## Prevention

Wrap the export call in `retryExportJob()` with three attempts. Do not hand a timed-out export to the alerting path before the retries are used.
