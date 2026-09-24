# Agent Note: Controlled team Agent platform MVP

Status: proposed

English | [中文](2026-09-06-team-agent-platform-mvp.zh.md)

## Problem

An internal quantitative-investment Agent must combine reviewed business knowledge with live database, NAS, log, monitoring, and automation access. The model must not become the authority for credentials, data scope, production approval, or dangerous mutations. The repository already has MCP, Skill, scoped tools, approval, sandbox, Session audit, presets, and worker-thread workflow capabilities, so a separate Agent framework would duplicate existing extension points and create incompatible policy paths.

## Proposal

Build the first deployment as private experimental packages and an external Git-managed knowledge workspace. Reuse the current capability packages without changing `packages/core/agent-loop`.

### Repository topology

The implementation uses existing package and bundle conventions:

| Path | Responsibility |
|---|---|
| `packages/experimental/quant-ops-mcp-server/` | Private MCP server that exposes the five bounded business and operations tools and enforces identity, resource scope, input limits, idempotency, and authoritative audit writes |
| `packages/experimental/quant-tool-policy/` | Cordis policy plugin over `tools/pre-execute` and `ctx.tools.guard()` that classifies tool names, denies forbidden tools monotonically, and requests one-operation approval where configured |
| `packages/experimental/quant-agent-profile/` | Installable private bundle that composes the policy plugin, `dsh-mcp-client`, permission defaults, skill discovery, Session persistence, and the pinned OpenViking bundle |
| `packages/experimental/README.md` and `packages/experimental/README.zh.md` | Group map entries for the three private packages when they are implemented |
| Deployment knowledge repository `.agents/skills/<name>/SKILL.md` | Git-reviewed business SOPs discovered by the existing `dsh-skill-filesystem` provider |
| Deployment knowledge repository `business/`, `ops/`, `architecture/`, and `decisions/` | Human-owned Markdown truth ingested into OpenViking with source path and commit metadata |

Each experimental package follows `packages/experimental/AGENTS.md`: it uses the `@deepseek-ai/dsh-experimental-*` prefix, remains private, and receives the same README, test, lifecycle, and security coverage as a release package. The profile follows the existing `packages/experimental/agent-team-profile/` bundle pattern. The MCP server remains an out-of-process authority and is connected through the existing `packages/mcp/mcp-client/`; business tools do not register directly on `ctx.tools`.

### First MCP tools

The server exposes exactly five v1 tools under one configured namespace:

- `product_lookup`: named-field lookup over approved product, strategy, account, and deployment views.
- `db_query_readonly`: named templates by default; optional SQL is accepted only after parser validation, read-only database credentials, schema allow-listing, and row, byte, and deadline limits.
- `nas_search`: allow-listed roots, canonical path containment, file-type and size limits, bounded excerpts, and no write operation.
- `log_query`: allow-listed services and hosts, bounded time ranges and result sizes, and backend-specific credentials hidden from the caller.
- `run_approved_script`: allow-listed operation ids with per-operation schemas, dry-run, idempotency keys, target and environment restrictions, audit-before-effect, a server-issued correlation id, and postcondition evidence. Harness asks before dispatch where configured. No L3 operation is registered in v1.

The MCP server derives the authenticated actor from its transport or workload identity. It never trusts an actor, role, approval result, target class, or environment supplied only in model arguments. Every response returns a correlation id and structured evidence; secrets and unrestricted command strings are neither inputs nor outputs.

### First skills

The deployment knowledge repository starts with eight skills: `answer-business-question`, `lookup-product-state`, `investigate-strategy-state`, `inspect-production-logs`, `diagnose-job-failure`, `rerun-data-pipeline`, `restart-approved-service`, and `prepare-strategy-switch`. The first five are read-only. The next two may request an L2 tool after preconditions and approval rules pass. `prepare-strategy-switch` is plan-only and cannot invoke a production mutation in v1.

Each skill states prerequisites, evidence sources, tool sequence, stop conditions, approval class, verification, and escalation. It cites vault documents by stable path and requests current facts through tools instead of embedding mutable product or host inventories.

### OpenViking integration

Install a pinned `@openviking/dsh-memory-plugin` release into the deployment profile instead of creating another memory abstraction in this repository. Configure automatic recall and capture only for eligible primary sessions, keep `captureToolResults` disabled until redaction is proven, and retain source repository, path, commit, owner, classification, and ingestion time for vault-derived resources.

The compatibility gate uses the exact deployed DSH and OpenViking plugin versions. It verifies one-time profile injection across resume, primary-session versus subagent isolation, failed-write replay, deletion and retention behavior, `viking://` URI protection, credential precedence, and startup behavior when OpenViking is unavailable. A failed or unavailable memory service may reduce recall, but it must not widen tool permissions or unblock an operation.

### Policy, approval, and audit

The profile exposes only tools required by its Agent preset. `quant-tool-policy` classifies each visible tool as L1, L2, or L3. It permits L1 after scope checks, asks for configured L2 production operations, and denies L3 monotonically in v1. The MCP server repeats authorization and never treats the Harness decision as sufficient authority.

`dsh-user-approval` provides the human decision and Session `approval/asked`/`approval/decided` records. The MCP server separately writes the authoritative append-only effect record before and after execution. It issues a correlation id, includes it in the effect record, and returns it in the tool result, where the Session log preserves it. An audit projection joins the Session decision and effect record by that id; the server does not trust model-supplied approval data. Audit storage failure prevents L2 execution.

### Execution and Temporal boundary

Version 1 does not add Temporal. An L2 action is one idempotent MCP operation or a submission to an existing durable scheduler or CI system; the tool observes that system's job id and result. The current `packages/workflow/` worker-thread engine may coordinate read-only evidence gathering and subagents, but it is not a security boundary or durable production transaction engine.

Add Temporal only when a validated use case needs process-independent waits, multi-system state, durable approval pauses, compensation, or retry after Harness restarts. Temporal activities call the same server-authorized operations, and workflow state carries the same correlation and idempotency identities.

## Alternatives considered

**Create a new top-level `agent-platform/` tree.** This would duplicate the repository's package grouping, profile bundles, Skill provider, MCP bridge, approval service, and workflow capability. Private experimental packages provide an explicit incubation boundary without introducing a second architecture.

**Implement business procedures as large MCP tools.** This would hide evidence collection and decision steps behind one server release and make procedure review inaccessible to business owners. Atomic tools plus Git-reviewed skills keep execution authority in the server and business reasoning in reviewable SOPs.

**Use OpenViking as the authoritative document store.** Runtime retrieval and extracted memory are mutable derived data. Git history, review, ownership, and rollback make the vault the authoritative source; OpenViking stores source document references and can be rebuilt.

**Introduce Temporal in the first milestone.** The first use cases are read-only or one idempotent bounded action. Temporal would add an operating dependency before a durable multi-step requirement is measured, while the built-in workflow engine still must not be mistaken for the eventual durability layer.

## Acceptance criteria

- The experimental profile loads with the five MCP tools, eight skills, current permission services, Session persistence, and a pinned OpenViking integration; a profile composition test rejects a missing authority or duplicate namespace.
- Unit tests reject SQL writes and disallowed schemas, NAS traversal and symlink escapes, excessive time ranges and result sizes, unknown operation ids, invalid targets, missing idempotency keys, secret-bearing output, and audit storage failure.
- MCP contract tests exercise the real stdio or Streamable HTTP bridge, cancellation, timeout, reconnect, structured results, server errors, and stable public names.
- Policy tests cover every L1/L2/L3 and environment combination, scoped tool visibility, monotonic denial, missing answerer, rejection, cancellation, and unavailable approval. Every uncertain state fails closed.
- Keyless profile snapshots pin the model-visible tool catalog, Skill catalog, policy context, approval result, and redaction behavior. Package tests pin audit correlation without storing credentials.
- An opt-in staging test writes a unique vault resource, recalls it in a new eligible Session, proves that an excluded subagent does not contaminate recall, runs one dry-run L2 operation, and reconciles the Session record with the authoritative audit record by correlation id.
- Production enablement begins in read-only shadow mode. L2 requires an observed dry-run period, named owners, on-call recovery instructions, and rollback through the downstream system. L3 remains unavailable.

## Risks

- OpenViking and DSH prerelease APIs may move independently; exact version pins and the compatibility test are release blockers.
- Session-derived memory can leak information across teams or subagents if actor and retention scopes are wrong; the first release favors isolation and excludes ambiguous sessions.
- A permissive MCP server would bypass client policy; server-side identity, authorization, target restrictions, and audit-before-effect remain mandatory.
- Database parsing alone cannot prove safety; read-only credentials, approved schemas, timeouts, and result limits are independent controls.
- The single `run_approved_script` entry point can become an unrestricted shell by accumulation; every operation requires a separate schema, owner, risk class, test, and allow-list entry, and raw commands stay forbidden.
