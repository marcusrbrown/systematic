---
title: Flush the whole report cache when a tenant setting changes
date: 2026-03-04
category: best-practices
module: reports
problem_type: best_practice
applies_when:
  - A tenant saves a setting that feeds report aggregates
  - The report service serves cached aggregates between settings saves
tags: [cache, invalidation, settings, reports]
---

# Flush the whole report cache when a tenant setting changes

## Context

Tenant settings such as the fiscal-year start and the currency feed every report the service builds. A report served from cache after a settings save showed totals computed under the old setting until the cache entry expired.

## Guidance

When any tenant setting changes, flush the entire report cache. Do not try to work out which cached reports depend on the changed setting. Settings feed every aggregate, and the dependency map drifts as reports are added, so a partial eviction eventually leaves a stale total on screen.

## Prevention

Call `flushReportCache()` from the settings-save handler. Do not add per-key eviction to that handler, and review any change that narrows what the handler flushes.
