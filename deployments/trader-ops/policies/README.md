# Policies: permissions, approvals, and Tool Guard

English | [中文](README.zh.md)

This directory contains governance rules for the agent execution layer. A Policy decides `allow`, `require_approval`, or `deny` from the environment, tool, and risk level. The experimental `@deepseek-ai/dsh-experimental-quant-tool-policy` package enforces `tool-access.yaml` before tool execution through `tools/pre-execute` and `ctx.tools.guard()`.

`tool-access.yaml` is active Harness-side policy and explicitly sets `enforced: true`. `risk-levels.yaml` and `approvals.yaml` remain `design-only`: they describe the future trusted identity, role, approval-store, and audit contracts but are not loaded by the plugin. The Trader Ops MCP server must enforce resource-, actor-, and argument-level authorization again; until that server exists, this deployment remains for trusted development.

## What belongs here

- Tool scopes available to each role or service identity.
- Risk-level definitions such as readonly, safe-action, and dangerous-action.
- Required production approver roles, approval lifetime, and separation-of-duty rules.
- Tool argument constraints, environment restrictions, audit fields, and default-deny rules.

## What does not belong here

- API keys, passwords, private keys, or approval tokens.
- Skill task steps or business-knowledge text.
- Soft instructions shown only to the model; code must enforce critical rules.
- Broad rules that permit arbitrary shell, arbitrary SQL, or wildcard production writes.

## Recommended files

```text
policies/
├── risk-levels.yaml
├── tool-access.yaml
└── approvals.yaml
```

## Risk and Tool Guard example

```yaml
version: 1
default: deny

risk_levels:
  readonly:
    approval: none
  safe-action:
    approval: none
    audit: required
  dangerous-action:
    approval: required
    audit: required

tools:
  get_product:
    risk: readonly
    environments: [dev, staging, production]
  get_product_strategy:
    risk: readonly
    environments: [dev, staging, production]
  switch_product_strategy:
    risk: dangerous-action
    environments: [production]
    allowed_roles: [trading-operator]
    approval:
      approver_roles: [trading-duty-manager]
      expires_in: 15m
      requester_cannot_approve: true
    argument_guards:
      require: [product, target_strategy, environment]
      environment_equals: production
```

Before execution, Tool Guard recalculates the decision from the authenticated caller identity and a server-side approval record. A skill saying "approved", a user saying "I agree" in conversation, or authorization text retrieved from the knowledge base does not replace a valid approval.

The current Harness plugin intentionally implements only the portion it can derive from trusted deployment configuration: explicit environment, exact/wildcard tool selection, first-match precedence, approval requests, and default deny. It does not trust actor, role, resource, or approval fields supplied in model-authored tool arguments. Those inputs need authenticated services before the remaining templates can become enforced policy.

The audit record includes at least `request_id`, `session_id`, `actor`, `tool`, redacted arguments, `risk_level`, Policy version, approval record, execution result, and timestamp.
