---
title: Store audit event timestamps in UTC only
date: 2026-04-08
category: best-practices
module: audit-log
problem_type: best_practice
applies_when:
  - The audit log records the time of an operator action
  - A reader compares an audit entry with what the operator saw on screen
tags: [audit-log, timestamps, utc, daylight-saving]
---

# Store audit event timestamps in UTC only

## Context

Sorting the audit log by timestamp put entries out of order twice a year, when daylight saving shifted the offset in the stored strings. A join against the session table also failed for entries written with a different offset.

## Guidance

Store audit event timestamps in UTC only. Never store local time or an offset string. Convert to the reader's zone when the entry is displayed, not when it is written.

## Prevention

Write the field with `formatUtc()`. Reject any timestamp that carries an offset other than `Z`.
