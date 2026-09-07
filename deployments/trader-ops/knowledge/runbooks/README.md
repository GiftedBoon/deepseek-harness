# Runbooks: retrievable operating procedures

English | [中文](README.zh.md)

This directory contains reviewed diagnostic and recovery procedures. OpenViking retrieves relevant sections to help the agent understand checks, failure causes, and verification criteria. A procedure that must trigger reliably and load in full remains a skill.

## What belongs here

- Failure symptoms, impact, diagnostic order, and recovery verification.
- Manual response guidance, escalation roles, and rollback principles.
- Formal runbooks created after humans review incident experience.
- Links to related business rules, system descriptions, and skills.

## What does not belong here

- Production-change instructions that execute from a retrieved fragment alone.
- The only source for permission or approval rules; those belong in `../../policies/`.
- Unverified chat transcripts, temporary guesses, or raw incident logs.
- Secrets or commands that bypass a tool guard.

## Example: `switch-strategy.md`

```markdown
---
type: runbook
domain: trading
owner: trading-operations
status: approved
risk_level: high
tags: [strategy, change, rollback]
updated_at: 2026-09-07
---

# Strategy switch runbook

## Applicable scenario

The operator has confirmed that a product must move from its current strategy to an approved target strategy.

## Manual checks

1. Confirm the product, environment, and target strategy.
2. Confirm that no conflicting change is active.
3. Obtain production-change approval.
4. Query the binding and process status after execution.

## Failure handling

Stop further changes, retain the tool-call and approval audit records, and escalate through the duty process. Do not attempt a second write without a reviewed rollback procedure.

## Automation entry point

The `switch-strategy` skill loads and orchestrates the complete automated procedure.
```
