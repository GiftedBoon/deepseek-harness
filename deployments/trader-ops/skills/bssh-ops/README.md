# bssh-ops skill

English | [中文](README.zh.md)

This bundle gives Harness the reviewed workflow for the `bssh_ops` remote operations MCP server. The complete instructions are in `SKILL.md`; Harness Skill Loader reads that file when a matching task is selected.

## What belongs here

- The bssh_ops tool-selection rules and the mandatory product preview-confirm-execute flow.
- Colo single-center/dual-center checks, custom-shell syntax checks, failure handling, and audit-safe output rules.
- References to live tool results, never copied product state or credentials.

## What does not belong here

- The MCP server implementation, URL, API key, or any other credential.
- Current colo status, product mappings, command output, or audit records.
- General product definitions; keep those in `../../knowledge/business/` and retrieve them through OpenViking.
- Permission and risk policy definitions; keep those in `../../policies/` and enforce them on the tool path.

The MCP patch is [trader-ops-bssh-ops-mcp.patch.yml](../../config/dsh/trader-ops-bssh-ops-mcp.patch.yml). It is disabled until the deployment environment supplies `TRADER_OPS_BSSH_MCP_ENABLED=1`, `TRADER_OPS_BSSH_MCP_URL`, and `TRADER_OPS_BSSH_MCP_API_KEY`.
