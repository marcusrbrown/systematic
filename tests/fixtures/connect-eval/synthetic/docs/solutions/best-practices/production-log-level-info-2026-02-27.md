---
title: Log at info level in production
date: 2026-02-27
category: best-practices
module: logging
problem_type: best_practice
applies_when:
  - Choosing the log level for a deployed service
  - A reviewer asks whether debug logging may stay enabled after a release
tags: [logging, log-level, production, privacy]
---

# Log at info level in production

## Context

Debug lines in the request path carry full request bodies. A debug setting left on after an incident wrote customer data into the log store.

## Guidance

In production, log at info level. Never enable debug in production, because debug lines include request bodies that the log store is not approved to hold.

## Prevention

Set the log level from the deployment manifest, and fail the release check when a production manifest sets anything below info.
