---
description: "Fail-closed YAML tool policy for Trader Ops deployments, with approval decisions in tools/pre-execute and a monotonic anti-bypass guard."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-quant-tool-policy

English | [中文](README.zh.md)

## Summary

This private experimental plugin turns a reviewed YAML file into a real Harness-side execution boundary. It resolves the first matching rule for the configured environment, returns `allow`, `ask`, or `deny` from `tools/pre-execute`, and repeats the deny boundary through `ctx.tools.guard()`. Unmatched tools are denied. The duplicate guard is deliberate: if another pre-execute listener short-circuits the waterfall before this plugin runs, the execution still fails closed.

This is one layer of defense, not the complete authorization system. A business MCP server must authenticate its caller, authorize the requested resource and arguments, validate approval records, and audit the operation again at the service boundary.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `ctx.tools` exists and pass an explicit policy path and environment:

```yaml
- name: '@deepseek-ai/dsh-experimental-quant-tool-policy'
  config:
    policyFile: ./deployments/trader-ops/policies/tool-access.yaml
    environment: development
```

The environment must be `development`, `staging`, or `production`; there is no inferred default. The policy must declare version 1, `enforced: true`, and `default: deny`. Each rule selects either exact `tools` or one anchored `*` wildcard `tool_pattern`:

```yaml
version: 1
status: experimental
enforced: true
default: deny

rules:
  - id: product-read
    tool_pattern: mcp__trader_ops__get_*
    risk: read_only
    environments: [development, staging, production]
    decision: allow

  - id: strategy-write
    tools: [mcp__trader_ops__switch_strategy]
    risk: privileged_operation
    environments: [production]
    decision: require_approval
```

Rule order is precedence: the first rule matching both environment and tool wins. `require_approval` becomes a Harness `ask` decision. If the active composition has no approval service, Harness denies the call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin reads and validates one immutable policy snapshot at load time. Invalid YAML, unsupported values, duplicate rule IDs, ambiguous selectors, `enforced: false`, and any default other than deny stop plugin startup.

The pre-execute listener records the exact `ToolExecution` object that crossed the policy. Allowed calls delegate to later listeners, approval rules return `ask`, and denied rules return `deny`. The monotonic guard then rejects explicit/default denies and also rejects any execution that did not traverse the listener. No guard can force-allow a denial from another policy.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | YAML validation, first-match resolution, pre-execute decision, and monotonic guard |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | Validation, allow/ask/deny, anti-bypass, and real Loader-path coverage |
| — | No invariant companion is published; the plugin owns no durable state or event-history relation. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tools subsystem](../../../docs/subsystems/tools.md) — the pre-execute, approval, guard, dispatch, and result pipeline.
- [Trader Ops policy directory](../../../deployments/trader-ops/policies/README.md) — deployment rules and the split between Harness and MCP enforcement.
- [Experimental package rules](../AGENTS.md) — private package naming and release isolation.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional approval or denial

#### What the model sees

The plugin adds no prompt or tool schema. An `allow` call is unchanged; `require_approval` opens the configured approval flow; a denied or unmatched call returns the policy reason as a tool error.

#### Token effect

Zero tokens on allowed calls. Approval and denial add only the existing Harness approval surface or a short error result.

#### KV Cache effect

Append-only; policy outcomes appear after the reusable request prefix and do not invalidate prior KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Harness-side identity only** — this version classifies environment and tool name; it does not yet consume a trusted actor, role, tenant, or resource identity.
- **No argument-level policy** — business constraints such as product ownership, trading windows, and target-strategy validity belong in the MCP service until trusted typed policy inputs exist.
- **Load-time snapshot** — changing the YAML requires a profile reload or process restart.
- **No replacement for MCP authorization** — a caller that can reach the MCP server outside Harness bypasses this plugin, so the service must repeat authorization and audit.
- **Experimental contract** — schema and package name may change before promotion to a released guard package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Promotion should wait for a trusted identity/approval service contract and a concrete Trader Ops MCP server. Keep policy inputs server-derived; never infer authorization from model text, retrieved knowledge, or tool arguments supplied by the model.

</details>
