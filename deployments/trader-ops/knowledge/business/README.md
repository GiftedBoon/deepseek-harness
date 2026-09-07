# Business concepts and rules

English | [中文](README.zh.md)

This directory defines business objects, their relationships, and durable business constraints. OpenViking indexes these documents so the agent has the required business meaning before it answers or acts.

## What belongs here

- Definitions of terms such as product, strategy, and account.
- Product-strategy relationships, trading windows, and state-transition rules.
- Field meanings, measurement conventions, boundary conditions, and authoritative data sources.
- Rule owner, review status, and last-updated date.

## What does not belong here

- Step-by-step database queries or strategy-switch actions; place them in `../../skills/`.
- Server addresses, deployment topology, or component operations; place them in `../systems/`.
- Incident-response steps; place them in `../runbooks/`.
- Live results such as a product's currently bound strategy.

## Example: `strategy-switch-rule.md`

```markdown
---
type: business-rule
domain: trading
owner: trading-operations
status: approved
risk_level: high
tags: [product, strategy, switch]
updated_at: 2026-09-07
---

# Strategy switch rules

A product can have only one active strategy at a time. The target strategy must belong to that product's allowed strategy set.

## Preconditions

- The product is within a business window that permits switching.
- Live interfaces confirm both the current and target strategies.
- The duty owner has approved a high-risk switch.

## Authoritative data sources

- Current binding: `get_product_strategy`
- Allowed strategies: `list_product_strategies`

This document defines rules only. It neither records a product's current strategy nor authorizes any tool call.
```
