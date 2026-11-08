---
title: Track the latest runtime patch in the local dev container
date: 2026-06-14
category: best-practices
module: build
problem_type: best_practice
applies_when:
  - Choosing which runtime version the local dev container installs
  - A developer reports a runtime security fix that has not reached their machine
tags: [dev-container, runtime, security, local-development]
---

# Track the latest runtime patch in the local dev container

## Context

Developers ran the local dev container on a runtime patch release that was months old, and security fixes reached their machines late.

## Guidance

In the local dev container, track the latest patch release of the runtime, so developers see security fixes and early signs of a breaking release before CI does. The container holds no production data.

## Prevention

Install the runtime in the dev container image by minor version, and rebuild the image weekly.
