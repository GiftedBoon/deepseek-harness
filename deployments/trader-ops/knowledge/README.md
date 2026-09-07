# Knowledge: retrievable business information

English | [中文](README.zh.md)

This directory is the Git source for team business knowledge. Reviewed documents are synchronized to OpenViking, where the agent retrieves fragments relevant to the current question; unlike a skill, they are not loaded completely or unconditionally.

## What belongs here

- Stable business concepts, terminology, field meanings, and business rules.
- System responsibilities, dependencies, interface descriptions, and data-source guidance.
- Runbook context, decision criteria, diagnostic steps, and recovery verification.
- Markdown with consistent YAML frontmatter that supports chunking and retrieval.

## What does not belong here

- Task procedures that the agent must follow step by step; write these as `../skills/<name>/SKILL.md`.
- Permission, approval, or tool-blocking rules; place these in `../policies/`.
- Current strategies, today's status, or live logs; query them through MCP or an API.
- Unreviewed temporary experience or raw data that contains secrets.

## Recommended document format

```markdown
---
type: business-rule
domain: trading
owner: trading-platform
status: approved
updated_at: 2026-09-07
tags:
  - product
  - strategy
---

# Product and strategy relationship

One product can bind to only one active strategy at a time.

## Data source

Query the current binding through the `get_product_strategy` MCP tool.

## Related material

- [Strategy switch rules](business/strategy-switch-rule.md)
- [Strategy switch runbook](runbooks/switch-strategy.md)
```

Frontmatter supports OpenViking filtering, authorization, and result ordering. The body contains stable facts; for changing values, name the authoritative source and query method instead of copying the current value.
