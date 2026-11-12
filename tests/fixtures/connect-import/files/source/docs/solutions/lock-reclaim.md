---
title: Reclaim stale locks only on verified identity
applies_when:
  - A lock file can outlive the process that took it
---

## Guidance

Never reclaim a lock without verifying the holder identity first.

## Prevention

Record the holder start time next to the pid.
