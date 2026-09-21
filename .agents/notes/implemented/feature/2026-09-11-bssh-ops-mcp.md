# Agent Note: bssh_ops remote operations MCP integration

Status: implemented

English | [中文](2026-09-11-bssh-ops-mcp.zh.md)

## Problem

The Trader Ops deployment needs a controlled connection to the existing bssh_ops HTTP MCP service for colo inspection and reviewed product operations. The connection must not place its API key in a patch or source file, and model-facing tools need stable names and an explicit execution policy.

## Decision

Add an optional `@deepseek-ai/dsh-mcp-client` layer at `config/dsh/trader-ops-bssh-ops-mcp.patch.yml`. It uses the `bssh-ops-remote` namespace, Streamable HTTP, and the `X-API-Key` header resolved from the root-owned deployment environment. The patch is loaded by every Trader Ops profile command but remains disabled until the environment enables it.

Add `configure-bssh-ops-mcp.sh` to prompt for the key, update the mode-0600 environment file, rebuild the profile, verify the policy and Skill layers, install the current systemd unit, and restart only after successful checks. The policy allows the read-only Harness `skill` loader, the bssh_ops inspection and preview tools, and the exact remote execution and change-cfg deployment tools. The Skill requires preview and explicit user confirmation, while the MCP service owns downstream authorization and audit.

The `bssh-ops` Skill records the mandatory preview-confirm-execute sequence for product actions, single/dual-center sanity checks, custom-shell syntax checks, machine-level command restrictions, and `run_id` audit handling. It contains no endpoint credential or live business state.

## Alternatives considered

**Put the API key in the MCP patch.** Rejected because patches are source-controlled and can be copied into logs or release archives; the key belongs in the root-owned environment file.

**Expose mutation tools without a preview step.** Rejected because product actions may target one or two physical colo hosts and can affect production processes; the Skill requires review before execution, and the allowlist names only the audited MCP mutation tools.

**Use a generic server name such as `trader_ops`.** Rejected because the stable `bssh-ops-remote` namespace identifies this external service and avoids collisions with another Trader Ops MCP server.

## Security and lifecycle

The bssh_ops endpoint is plain HTTP on a private network and must not be exposed to the public Internet. The API key stays in `/etc/deepseek-harness/trader-ops.env` with mode `0600`; configuration prompts avoid shell history. Harness does not issue a second approval prompt for the allowlisted mutation tools, so the deployment relies on the Skill confirmation workflow and bssh_ops actor-, resource-, argument-level authorization, and audit. The same key replaces the admin/trader role check on the four change-cfg endpoints, so its scope is the only limit on an agent-initiated change-cfg call. `deploy_change_cfg_paras` re-verifies the plan digest returned by its preview before generating any cfg.

## Verification

The Skill passes the Skill Creator validator. Profile rendering confirms the MCP layer is inserted and disabled by default. Static policy resolution confirms that the `skill` loader and every bssh_ops tool named by the Skill or the WeCom scheduled actions is allowed while an unlisted bssh_ops tool remains denied; `scripts/verify-deployment.sh` runs that resolution through `scripts/verify-skill-tool-policy.mjs`. The configurator installs the unit containing the bssh_ops patch before reloading systemd. Shell syntax and repository documentation checks must pass before publishing.

## Consequences

Enabling the layer makes bssh_ops tool descriptions and user requests model-visible to the configured relay. Tool names use the stable `mcp__bssh-ops-remote__` prefix. Disabling the layer preserves the stored key for rotation or later re-enable, so operators must rotate it when the upstream credential changes.
