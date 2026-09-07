# Agent Note: Trader Ops empty-state deployment scaffold

Status: implemented

English | [中文](2026-09-07-trader-ops-deployment-scaffold.zh.md)

## Problem

The Trader Ops deployment owns separate `knowledge/`, `skills/`, and `policies/` roots, but none of them has production content yet. Development still needs a reproducible way to start OpenViking, install its DSH plugin, register the deployment-local skill root, validate the composed profile, and move the same setup to a remote host without committing credentials.

An empty directory layout alone does not establish runtime wiring. Conversely, placeholder knowledge or fake skills would make the deployment look more complete than it is. Policy examples are especially risky if readers can mistake descriptive YAML for an enforced tool guard.

## Decision

Add a deployment-owned, empty-state scaffold under `deployments/trader-ops/`:

- Docker Compose runs OpenViking with persistent storage and a loopback-only published port.
- A checked-in DSH patch configures the installed OpenViking runtime and adds a dedicated filesystem skill provider for `deployments/trader-ops/skills`.
- A bootstrap script pins `@openviking/dsh-memory-plugin@0.3.0`, installs it into the selected Profile, and verifies the effective configuration with `--dump-config`.
- A verification script checks OpenViking health/readiness, DSH configuration composition, and reports zero knowledge documents or skills as a valid state.
- Environment templates contain no real secrets; remote deployment uses a mode-`0600` environment file and persistent state outside the release directory.
- Trader Ops MCP configuration remains a disabled example until an actual server and reviewed tool schemas exist.
- `tool-access.yaml` is enforced by the private experimental `quant-tool-policy` package through `tools/pre-execute` and a monotonic `ctx.tools.guard()` fallback. Unmatched tools are denied. The broader risk and approval documents remain design contracts until trusted identity and approval stores exist.

The OpenViking memory plugin does not imply automatic Git knowledge ingestion. Later work must define reviewed add, update, and delete semantics for synchronizing `knowledge/` into OpenViking.

## Validation boundary

The scaffold validates package installation, patch composition, service health, and empty content discovery. It does not validate a VLM or embedding provider because those credentials and model choices are deployment-specific and are created through `openviking-server init` outside Git.

It also does not claim business authorization. DSH sandbox permissions, OpenViking authentication, and Trader Ops tool policy are separate boundaries; all three must be configured before untrusted or production access.

## Alternatives considered

- Commit a complete `ov.conf` template with guessed model providers. Rejected because the required VLM, embedding model, endpoints, and credentials vary by environment, and a plausible-looking template would encourage invalid or insecure deployments.
- Let the OpenViking installer select the latest plugin on every host. Rejected for the scaffold because remote deployments need reproducible package resolution; version upgrades should be reviewed explicitly.
- Add placeholder `SKILL.md` and knowledge documents. Rejected because empty discovery is a supported state and fake content would blur the boundary between infrastructure readiness and business readiness.
- Treat descriptive policy YAML as sufficient on its own. Rejected because configuration without an execution hook creates a false security boundary; the scaffold instead loads a tested Harness plugin and separately documents the MCP server's final authorization responsibility.

## Consequences

Developers can bring up and validate the integration before business content exists, and operators have an explicit remote filesystem layout and startup sequence. Adding a skill later requires only a valid direct-child `SKILL.md`; adding knowledge still requires a separately reviewed ingestion path.

The Harness-side tool-name/environment boundary is now active and explicitly denies OpenViking permanent-forget. The remaining unfinished area is the real Trader Ops MCP service and its trusted identity, resource/argument authorization, durable approval, and audit stores. Access stays limited to trusted developers until that final service boundary exists.

Pinning plugin version `0.3.0` improves repeatability but creates an intentional maintenance task: any Harness or OpenViking upgrade must re-check Node requirements, peer dependencies, effective configuration, and health/readiness behaviour.
