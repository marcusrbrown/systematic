---
title: Never retry an export job after a timeout
date: 2026-06-02
category: best-practices
module: exports
problem_type: best_practice
applies_when:
  - An export job times out while waiting for the export endpoint
  - A scheduler decides whether to run a failed export job again
tags: [exports, retry, timeout, idempotency, billing]
---

# Never retry an export job after a timeout

## Context

A timed-out export had often completed on the server. Each automatic retry created a second export file and a second billing record for the same data, and customers saw duplicate downloads.

## Guidance

Never retry an export job after a timeout. The export endpoint creates a new export on every call and is not idempotent, so a retry duplicates the file and the charge. Fail the job once and alert the owner instead.

## Prevention

Send each export call once through `runExportJob()` and alert on the first timeout. Do not wrap the export call in a retry helper.
