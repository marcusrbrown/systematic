---
title: Evict only the affected tenant's report cache when a tenant setting changes
date: 2026-05-19
category: best-practices
module: reports
problem_type: best_practice
applies_when:
  - A tenant saves a setting that feeds report aggregates
  - The report service serves cached aggregates between settings saves
tags: [cache, invalidation, settings, reports, stampede]
---

# Evict only the affected tenant's report cache when a tenant setting changes

## Context

A settings save by one large tenant emptied the report cache for every tenant. The next minute of traffic rebuilt every report from the database at once, and the database fell behind for several minutes.

## Guidance

When a tenant setting changes, evict only that tenant's report cache keys. A tenant's setting never changes another tenant's totals, so a whole-cache flush buys nothing and makes every other tenant pay a rebuild at the same moment.

## Prevention

Call `evictTenantReports(tenantId)` from the settings-save handler. Never call `flushReportCache()` on a settings change, and review any change that widens what the handler evicts.
