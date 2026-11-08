---
title: Pin the runtime to an exact version in CI
date: 2026-03-30
category: best-practices
module: build
problem_type: best_practice
applies_when:
  - Choosing which runtime version a CI job installs
  - A build passes locally and fails in CI after a runtime release
tags: [ci, runtime, version-pinning, reproducibility]
---

# Pin the runtime to an exact version in CI

## Context

A CI job that installed the newest patch release of the runtime started failing on a Tuesday with no change in the repository. The cause was a runtime release that morning, and the fix took half a day to find.

## Guidance

In CI, pin the runtime to an exact version, patch number included, so every build uses the same runtime until someone changes the pin on purpose.

## Prevention

Read the runtime version from one pinned file in the repository, and let the dependency bot propose the bumps.
