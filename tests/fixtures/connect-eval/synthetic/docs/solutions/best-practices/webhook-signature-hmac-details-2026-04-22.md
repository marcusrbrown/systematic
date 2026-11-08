---
title: Compute webhook signatures with HMAC-SHA256 over the raw body
date: 2026-04-22
category: best-practices
module: webhooks
problem_type: best_practice
applies_when:
  - The service receives webhook calls from a partner
  - A change touches the webhook receiver before the body is parsed
tags: [webhooks, signatures, hmac, replay]
---

# Compute webhook signatures with HMAC-SHA256 over the raw body

## Context

A receiver that parsed the body before it checked the signature compared a re-serialized body against the signature, and valid calls were rejected after a key-order change.

## Guidance

Compute the signature as HMAC-SHA256 over the raw request body with the shared secret. Compare it in constant time, and reject any call whose timestamp header is older than five minutes, so a captured call cannot be replayed.

## Prevention

Read the raw body once, keep it as bytes, and pass the same bytes to the signature check and to the parser.
