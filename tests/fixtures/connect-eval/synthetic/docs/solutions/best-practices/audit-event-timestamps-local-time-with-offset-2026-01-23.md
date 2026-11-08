---
title: Store audit event timestamps in local time with an explicit offset
date: 2026-01-23
category: best-practices
module: audit-log
problem_type: best_practice
applies_when:
  - The audit log records the time of an operator action
  - A reader compares an audit entry with what the operator saw on screen
tags: [audit-log, timestamps, time-zones]
---

# Store audit event timestamps in local time with an explicit offset

## Context

Auditors read the log next to the operator's own screen recordings. Entries stored in a time zone the operator never saw sent them hunting for the matching moment.

## Guidance

Store each audit event timestamp in the operator's local time with an explicit offset string, for example `2026-01-23T09:30:00-05:00`. Readers then see the time the operator saw, and the offset keeps the entry unambiguous.

## Prevention

Write the field with `formatLocalWithOffset()`. Do not convert a timestamp to another zone before it is stored.
