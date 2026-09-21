---
description: "Reference architecture for a team Agent platform that combines DeepSeek Harness, a Git-managed Markdown vault, OpenViking, MCP tools, and controlled operational workflows."
---

# Build a controlled team Agent platform

English | [中文](team-agent-platform.zh.md)

## Summary

This reference architecture uses DeepSeek Harness as the Agent runtime, a Git-managed Markdown vault as the human source of truth, OpenViking as runtime context and memory, and MCP as the boundary to business and operational systems. It targets internal quantitative-investment use cases such as business knowledge questions, database and NAS lookup, log diagnosis, approved script execution, and product or strategy workflows. Version 1 keeps execution short-lived and uses the existing Harness approval and audit paths; it does not add Temporal. Production mutations remain fail-closed, server-authorized, human-approved, and independently audited.

## Table of Contents

- [Goals and boundaries](#goals-and-boundaries)
- [Architecture](#architecture)
- [Responsibilities](#responsibilities)
- [Permissions, approval, and audit](#permissions-approval-and-audit)
- [Version 1 deployment](#version-1-deployment)
- [Upgrade path](#upgrade-path)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="goals-and-boundaries"></a>
## Goals and boundaries

The platform gives teams one governed Agent entry point without making the model the authority for production changes.

- Answer product, strategy, trading, operations, and incident questions from reviewed knowledge and live read-only systems.
- Query approved database views, NAS paths, logs, monitoring, and job state through typed tools.
- Run allow-listed scripts for bounded operational actions and return verification evidence.
- Encode business procedures as reviewable skills instead of hiding decisions inside large tools.
- Preserve the actor, request, approval, execution target, arguments, result, and verification evidence for every mutation.

Version 1 does not let an Agent directly perform strategy switches, trading stops, production configuration changes, unrestricted process termination, arbitrary database writes, or multi-system rollback. Such requests may produce a plan and evidence bundle, but execution stays in an existing human-operated system until the durable workflow tier is available.

-----

<a id="architecture"></a>
## Architecture

Each layer owns one kind of decision. The model may select a skill and request a tool, but it cannot grant itself identity, data scope, approval, or production authority.

```text
Web / CLI / enterprise messaging / API
                    |
          DeepSeek Harness runtime
          session | agent | preset
                    |
       +------------+-------------+
       |            |             |
Git/Vault skills  OpenViking    MCP tools
and knowledge     context       and servers
       |            |             |
       +------------+-------------+
                    |
       policy -> approval -> audit
                    |
 DB views | NAS | logs | monitoring | approved scripts
                    |
       durable workflow tier (later)
```

The current repository already supplies the required extension points: the [Skill registry and filesystem provider](../../../packages/skill/README.md), [MCP client bridge](../../../packages/mcp/mcp-client/README.md), [tool execution pipeline](../../../packages/core/tools/README.md), [approval service](../../../packages/interaction/user-approval/README.md), [permission presets](../../../packages/interaction/permission-presets/README.md), [sandbox policy](../../../packages/sandbox/sandbox-policy/README.md), [Session log](../../../packages/session/README.md), and [workflow capability](../../../packages/workflow/README.md). A team deployment composes these packages through a profile and adds business-specific providers and policy plugins; it does not modify `agent-loop`.

-----

<a id="responsibilities"></a>
## Responsibilities

The knowledge, memory, skill, and tool layers are separate because they have different authors, review requirements, failure modes, and security authority.

| Layer | Owns | Must not own |
|---|---|---|
| Harness | Agent loop, Session lifecycle, tool registration and execution, hooks, presets, subagents, approval routing, and model-visible context | Business truth, production credentials, or durable cross-system transactions |
| Git/Vault | Reviewed Markdown knowledge, runbooks, decision records, skill source, ownership, and change history | Per-request retrieval ranking or hidden mutable Agent memory |
| OpenViking | Runtime retrieval, profile and memory context, session capture, memory extraction, and recall | Approval, production authorization, or the authoritative copy of reviewed procedures |
| Skill | A business SOP: prerequisites, evidence to collect, decision points, tool order, verification, and escalation | Credentials, unrestricted code execution, or a substitute for server-side authorization |
| Tool/MCP server | One typed capability with input validation, bounded output, target restrictions, timeout, and a verifiable result | Open-ended business judgment or a complete multi-step business process |
| Workflow | Ordered execution, retries, checkpoints, compensation, and resume for an approved plan | Deciding whether the caller is authorized or whether approval is required |

### Skill and tool split

A tool remains atomic, for example `product_lookup`, `db_query_readonly`, `nas_search`, `log_query`, or `run_approved_script`. A skill such as `diagnose-job-failure` explains which evidence to collect, how to interpret it, when to stop, and which tool may run next. Do not expose a single `switch_strategy_and_do_everything` tool: it hides policy decisions, prevents step-level evidence review, and couples business procedure changes to server releases.

The existing `dsh-skill-filesystem` provider discovers workspace and user skill roots, while `dsh-tool-skill` publishes the catalog and loader. Store team skills in the team knowledge repository's discovered `.agents/skills/<name>/SKILL.md` paths so normal Git review governs them. Keep product facts and runbooks outside `SKILL.md`; a skill links or searches for those facts instead of copying them.

### Vault/Git and OpenViking split

Git/Vault is the human source of truth. Teams edit Markdown, review changes, merge them, and can identify or revert the exact procedure version. OpenViking is a derived runtime context service: it ingests approved sources, retrieves relevant context, and stores session-derived memory according to retention policy. Every OpenViking item that derives from the vault must retain a source repository, path, commit, document owner, classification, and ingestion time so an answer can cite the authoritative version.

Use OpenViking's native DSH bundle for automatic recall and capture only after pinning a version compatible with the deployed DSH release. Its [DSH plugin documentation](https://github.com/volcengine/OpenViking/blob/main/examples/dsh-memory-plugin/README.md) describes lifecycle injection, capture, pending-write replay, URI protection, and memory tools. The rollout must verify resume deduplication, subagent isolation, deletion behavior, credential resolution, and fail-closed degradation against the pinned release before production use. The generic [memory MCP guide](mcp-memory.md) remains the fallback when a deployment needs explicit model-invoked memory rather than lifecycle integration.

-----

<a id="permissions-approval-and-audit"></a>
## Permissions, approval, and audit

Authorization is enforced where the effect occurs. Harness policy and approval improve control and user experience, but an MCP server or downstream service must reject an unauthorized caller even if the Agent bypasses its prompt or a client-side plugin is misconfigured.

| Level | Examples | Execution policy |
|---|---|---|
| L1 — read only | Product status, approved DB views, NAS lookup, logs, monitoring, analysis | Automatic after identity and resource-scope checks; query, row, byte, and time limits still apply |
| L2 — bounded action | Rerun an allow-listed job, refresh a cache, fetch missing data | Named operation only, typed parameters, idempotency key, role and environment checks, complete audit; version 1 may require approval for every production action |
| L3 — dangerous action | Switch strategy, stop trading, deploy production, change production configuration or data, terminate a process | Fail closed; human approval is mandatory; version 1 returns a plan or delegates to the existing controlled system rather than executing a multi-step mutation |

Use scoped tool visibility to remove capabilities an Agent never needs, `tools/pre-execute` for deployment policy that may allow, deny, or ask, and `ctx.tools.guard()` for monotonic denials that later listeners cannot reverse. Use `dsh-user-approval` for one-operation decisions and keep `approval/asked` and `approval/decided` in the requesting Session. The MCP server repeats identity, role, target, environment, maintenance-window, and allow-list checks before producing an effect.

The Session log is the Agent interaction record, not the only security ledger. Harness records the tool call and human approval; the effecting service writes an append-only record with its authenticated actor, server-issued correlation id, redacted normalized arguments, target, timing, idempotency key, outcome, and verification evidence. The service returns that correlation id in the tool result, which lets an audit projection join the Session decision to the effect record without treating model arguments as authority. Audit write failure blocks L2 and L3 execution. Credentials use references from the [credentials capability](../../../packages/credentials/README.md); neither skills nor tool arguments carry raw secrets.

-----

<a id="version-1-deployment"></a>
## Version 1 deployment

Version 1 is a controlled read-mostly deployment. It reuses repository packages and adds the minimum deployment-owned code described in the [proposed implementation note](../../../.agents/notes/proposed/feature/2026-09-06-team-agent-platform-mvp.md).

The first MCP surface contains five operations:

1. `product_lookup` reads normalized product, strategy, account, and deployment metadata from approved views.
2. `db_query_readonly` executes a validated read-only query or named query template with schema, row, byte, and time limits.
3. `nas_search` searches and reads allow-listed roots with path normalization, file-type limits, and bounded excerpts.
4. `log_query` queries approved log and monitoring backends by service, host, time range, and bounded filter fields.
5. `run_approved_script` invokes an allow-listed operation id with typed parameters, dry-run support, idempotency, a server-issued correlation id, and postcondition evidence; Harness policy asks before dispatch where configured, and version 1 excludes L3 operations.

The first skill catalog contains `answer-business-question`, `lookup-product-state`, `investigate-strategy-state`, `inspect-production-logs`, `diagnose-job-failure`, `rerun-data-pipeline`, `restart-approved-service`, and `prepare-strategy-switch`. The last skill stops after producing the target state, current evidence, risk checks, approval requirements, execution steps, verification, and rollback plan.

Version 1 uses DSH Session persistence and downstream audit storage, not Temporal. A bounded L2 action is either one idempotent MCP call or a submission to an existing durable job system such as the organization's scheduler or CI service. The built-in worker-thread workflow can collect evidence and coordinate subagents, but it is isolation rather than a security or durability boundary and does not own production mutation reliability.

-----

<a id="upgrade-path"></a>
## Upgrade path

Add a durable workflow engine when real cases require waits across process restarts, multi-system commits, compensating actions, durable approval pauses, or retry policies that must survive the Harness process. The Agent then submits a typed, approved workflow request and observes its state; Temporal activities call the same server-authorized capabilities, so introducing Temporal does not weaken or duplicate the MCP authorization layer.

Later upgrades can add two-person approval for trading-critical changes, policy-as-code with reviewed resource rules, short-lived workload identities, evidence-signed execution reports, OpenTelemetry correlation, automated vault ingestion with deletion propagation, and promotion rules that move a skill from read-only advice to bounded action only after replay and production-shadow evidence pass.

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client bridge](../../../packages/mcp/mcp-client/README.md) — external tool discovery, stable names, lifecycle, and failure behavior.
- [Skills subsystem](../../subsystems/skills.md) — provider, catalog, invocation, and loading contracts.
- [Tools subsystem](../../subsystems/tools.md) — scoped visibility and the complete execution policy pipeline.
- [Approval subsystem](../../subsystems/approval.md) — one-operation approval and durable audit events.
- [Workflow subsystem](../../subsystems/workflow.md) — current worker-thread workflow semantics and limits.
- [Third-party memory MCP guide](mcp-memory.md) — explicit memory-server overlays already present in this repository.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Maintainer working context — click to expand</summary>

This page defines the target deployment architecture, not a claim that the business-specific MCP server, policy plugin, profile, vault, or OpenViking integration is shipped by this repository. The proposed Agent Note owns the version 1 implementation checklist and acceptance state.

</details>
