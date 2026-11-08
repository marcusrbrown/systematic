---
title: Verify the signature on every incoming webhook
date: 2026-01-30
category: best-practices
module: webhooks
problem_type: best_practice
applies_when:
  - The service receives webhook calls from a partner
  - A change touches the webhook receiver before the body is parsed
tags: [webhooks, signatures, security]
---

# Verify the signature on every incoming webhook

## Context

The webhook receiver accepted any caller that knew the URL. A forged call changed an order status before anyone noticed.

## Guidance

Verify the signature on every incoming webhook before the body is parsed or acted on. A call with a missing or wrong signature gets a rejection and no further processing.

## Prevention

Run the signature check as the first step of the receiver, and keep a test that sends an unsigned call and expects a rejection.
