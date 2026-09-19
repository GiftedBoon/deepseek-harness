# Agent Note: Governed database queries in Trader Ops

Status: implemented

English | [中文](2026-09-18-trader-ops-governed-database-query.zh.md)

## Problem

Trader Ops needs to inspect operational data in Microsoft SQL Server and ClickHouse, but the existing Agent can reach only the command-oriented bssh_ops tools. Giving the Agent the database-query CLI or an unrestricted SQL transport would bypass the deployment tool policy, central audit trail, result limits, and stable error handling that team use requires. A separate MCP deployment would duplicate authentication, service management, and Harness connection configuration already owned by bssh_ops.

## Decision

The existing `bssh-ops-remote` MCP connection exposes four database tools: connection discovery, table discovery, schema inspection, and SQL query execution. The MCP process remains a thin authenticated HTTP adapter; the data-analysis backend owns connection aliases, SQL validation, execution limits, concurrency, response shaping, and query audit records. An absent or empty connection allowlist exposes no database. Harness grants the four exact tool names through deployment policy with a 75-second tool timeout.

The `database-query` Skill owns the Agent workflow independently from the command-oriented bssh_ops Skill. It requires connection and schema discovery before query construction, instructs the Agent to begin with bounded aggregate or sample queries, and requires user-visible reporting of the query id and truncation state. The Skill cannot override backend rejection or obtain an unregistered connection.

The `pre-open-status-check` Skill is a deterministic business workflow over the same tools. It checks the rows at the maximum `ProductionMonitorData.CreateTime`, treats an empty batch as indeterminate, reports success only when every `PnLratio` is exactly zero, and fetches product details only for nonzero or null values. It reports the snapshot time without inventing a freshness threshold and does not infer whether a failed check means processing is still running or an unopened product is abnormal.

The backend accepts one SQL query, parses it with the configured database dialect, rejects non-query statements and dangerous external-source functions, constrains cross-database access, and applies an outer row cap. Separate bounded SQLAlchemy pools and global and per-connection semaphores isolate Agent traffic from existing application pools. Audit rows record identity, connection, normalized SQL hash, referenced tables, timing, status, row count, byte count, and stable error code without storing raw SQL or returned data.

The connection layer currently reuses the deployment's existing SQL Server and ClickHouse credentials. Application-layer validation therefore provides the immediate write guard, while database-native read-only accounts remain an independent hardening step.

## Alternatives considered

**Deploy a separate database MCP service.** Rejected because it duplicates the existing API-key boundary, process supervision, health checks, and Harness connection configuration without creating a stronger authorization boundary. The existing MCP namespace keeps one operational ingress while the backend isolates query execution internally.

**Let the Skill invoke the database-query CLI directly.** Rejected because local process access would make enforcement depend on prompt compliance and would fragment audit and resource controls. Every database request instead crosses exact Harness tool policy and backend validation.

**Add the workflow to the existing bssh_ops Skill.** Rejected because remote command execution and analytical SQL have different discovery, safety, and result-interpretation rules. Separate Skills keep triggering and operating guidance focused even though they share one MCP connection.

**Encode every business check in the generic database-query Skill.** Rejected because business-specific tables, fixed SQL, decision states, and reporting language would make generic discovery guidance noisy and easier to misuse. Narrow business Skills reuse the governed tools while owning their exact metric semantics.

**Rely only on SQL text prefixes.** Rejected because comments, common table expressions, nested expressions, and dialect syntax make prefix checks bypassable. The backend validates the parsed syntax tree and fails closed when parsing or classification is uncertain.

## Verification

Policy tests cover statement classification, stacked statements, mutations hidden behind common table expressions, external-source functions, cross-database references, and row-limit rewriting. API tests cover Agent-key authentication and stable error mapping. MCP registration inspection verifies all four tools, while Trader Ops policy verification confirms that each referenced tool is allowed in every deployment environment.

## Consequences

- Trader Ops can perform bounded SQL analysis through its existing authenticated operational connection without a second MCP deployment.
- Database policy, resource limits, and audit behavior have one backend owner instead of being duplicated in prompts or MCP wrappers.
- Query audit identifies the shared Agent API identity rather than an individual teammate until per-user identity propagation is introduced.
- Reusing existing database credentials leaves a defense-in-depth gap: a defect below the SQL policy layer could reach credentials with their existing privileges, so native read-only accounts remain recommended before broader exposure.
