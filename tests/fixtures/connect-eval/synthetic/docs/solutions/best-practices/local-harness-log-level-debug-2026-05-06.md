---
title: Log at debug level in the local fixture harness
date: 2026-05-06
category: best-practices
module: logging
problem_type: best_practice
applies_when:
  - Choosing the log level for the local fixture harness
  - A developer cannot tell which stubbed call a test failure came from
tags: [logging, log-level, fixtures, local-development]
---

# Log at debug level in the local fixture harness

## Context

The local fixture harness replays canned responses. When a test failed, an info-level log did not show which stubbed call had been served, and developers added temporary print statements.

## Guidance

In the local fixture harness, log at debug level so that every stubbed call is visible. The harness holds only invented data, so the extra detail exposes nothing real.

## Prevention

Default the harness configuration to debug, and keep the harness out of any deployment manifest.
