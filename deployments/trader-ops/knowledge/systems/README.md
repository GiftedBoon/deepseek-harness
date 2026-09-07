# Systems and dependencies

English | [中文](README.zh.md)

This directory records system responsibilities, component relationships, data flows, interface semantics, and observability entry points. OpenViking retrieves this material to help the agent locate the correct system and tool.

## What belongs here

- System boundaries, owners, upstream and downstream dependencies, and environment differences.
- The backend service behind each MCP tool and its read or write semantics.
- Explanations of database tables, API fields, and monitoring metrics.
- Redacted host roles, service names, and failure-domain descriptions.

## What does not belong here

- Passwords, tokens, private keys, complete production connection strings, or other secrets.
- Dangerous commands that can be executed directly.
- Business concept definitions; place them in `../business/`.
- Response procedures for a specific incident; place them in `../runbooks/`.

## Example: `strategy-control.md`

```markdown
---
type: system
system: strategy-control
owner: trading-platform
status: approved
tags: [strategy, mcp, production]
updated_at: 2026-09-07
---

# Strategy Control

Strategy Control is the authoritative service for product-strategy bindings.

## Agent integration

| Tool | Behaviour | Data freshness |
|---|---|---|
| `get_product_strategy` | Read the current binding | Live |
| `switch_product_strategy` | Change the production binding | Live, high risk |

## Constraints

Write tools must pass the identity, risk, and approval checks in `policies`. The agent must not infer production state from example values in this document.
```
