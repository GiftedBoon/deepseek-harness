# switch-strategy skill

English | [中文](README.zh.md)

This directory contains the complete "switch product strategy" skill bundle. This is a high-risk write: the skill organizes checks, planning, approval, execution, and verification, but a Policy, Hook, or Tool Guard must enforce final authorization instead of relying on the prompt.

## What belongs here

- Product and target-strategy confirmation, preflight checks, an execution plan, and post-execution verification.
- Explicit requirements for high-risk Policy decisions, human approval, and audit fields.
- Stopping conditions for tool failure, approval rejection, or state drift.
- Reviewed rollback references; escalate to a human when no safe rollback exists.

## What does not belong here

- Hard-coded approver identities or long-lived approval tokens.
- Instructions to bypass Policy, execute direct SSH commands, or retry blindly.
- The only copy of a business rule; authoritative rules belong in `../../knowledge/business/`.
- The internal implementation of the `switch_product_strategy` tool.

## `SKILL.md` example

```markdown
---
name: switch-strategy
description: Switch a product strategy after risk checks and human approval, then verify the final state.
whenToUse: Use when the user explicitly asks to switch a specified product to a specified target strategy.
user-invocable: true
disable-model-invocation: false
---

# Switch Strategy

1. Require the product code, target strategy, and target environment; stop when any value is missing.
2. Use read-only tools to query the current strategy, allowed targets, business window, and conflicting changes.
3. Build a plan from retrieved, reviewed business rules, but do not perform a write.
4. Submit an approval request with product, environment, old strategy, target strategy, risk level, and plan.
5. Call `switch_product_strategy` exactly once and only after Tool Guard returns a valid approval.
6. Call read-only tools again to verify the binding and runtime state, then report the audit ID.
7. Stop immediately on any failure, state drift, or expired approval; never bypass the Guard or retry blindly.
```
