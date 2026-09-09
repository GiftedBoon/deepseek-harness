# Agent Note: Trader Ops empty-state deployment scaffold

Status: implemented

English | [中文](2026-09-07-trader-ops-deployment-scaffold.zh.md)

## Problem

The Trader Ops deployment owns separate `knowledge/`, `skills/`, and `policies/` roots, but none of them has production content yet. Development still needs a reproducible way to start OpenViking, install its DSH plugin, register the deployment-local skill root, validate the composed profile, and move the same setup to a remote host without committing credentials.

An empty directory layout alone does not establish runtime wiring. Conversely, placeholder knowledge or fake skills would make the deployment look more complete than it is. Policy examples are especially risky if readers can mistake descriptive YAML for an enforced tool guard.

## Decision

Add a deployment-owned, empty-state scaffold under `deployments/trader-ops/`:

- Docker Compose runs OpenViking with persistent storage and a loopback-only published port.
- The macOS MVP runs Ollama natively on the host for Metal-accelerated embedding and query planning. The OpenViking container reaches it through `host.docker.internal`; the committed local configuration uses environment placeholders rather than credentials.
- An optional DSH patch declares an AIHubMix endpoint as an OpenAI-compatible `llm-pi-ai` route. `TRADER_OPS_LLM_PROVIDER` selects it; the ordinary Profile model remains the default when the patch is absent. OpenViking uses the same remote route for semantic extraction.
- OpenViking account administration uses a root key, while Harness and ordinary data commands use a separate tenant user key.
- A checked-in DSH patch configures the installed OpenViking runtime and adds a dedicated filesystem skill provider for `deployments/trader-ops/skills`.
- A bootstrap script pins `@openviking/dsh-memory-plugin@0.3.0`, installs it into the selected Profile, and verifies the effective configuration with `--dump-config`.
- A verification script checks OpenViking health/readiness, DSH configuration composition, and reports zero non-empty knowledge documents or skills as a valid state. Empty and whitespace-only Markdown is excluded from the ingestable count.
- Environment templates contain no real secrets; remote deployment uses a mode-`0600` environment file and persistent state outside the release directory.
- The Debian MVP uses three explicit phases: a root host bootstrap with verified downloads, a non-root exact-commit release build, and a root runtime configurator that reads the rotated relay key from a hidden terminal prompt.
- Release-time configuration and systemd invoke the built DSH CLI directly. The deployment overlay resolves the private policy plugin from that release, while the external Profile owns only out-of-tree dependencies. The pnpm-backed source launcher remains limited to writable development checkouts and cannot reconcile dependencies inside an immutable release.
- Runtime configuration smoke-tests the remote model with the Trader Ops plugins loaded, then requires a successful Web response or the expected authentication challenge and a stable systemd restart count. The unit rate-limits repeated startup failures.
- Native Ollama listens only on the Docker bridge gateway on Linux, and OpenViking and Harness remain loopback-only. An optional systemd socket binds one host-owned IPv4 address and proxies it to Harness; `--trusted-host` admits that authority through the browser Host/Origin fence without enabling the CLI's prohibited wildcard bind. The configurator rejects wildcard and non-local proxy addresses, and the MVP does not add a public reverse proxy.
- Trader Ops MCP configuration remains a disabled example until an actual server and reviewed tool schemas exist.
- `tool-access.yaml` is enforced by the private experimental `quant-tool-policy` package through `tools/pre-execute` and a monotonic `ctx.tools.guard()` fallback. Unmatched tools are denied. The broader risk and approval documents remain design contracts until trusted identity and approval stores exist.

The OpenViking memory plugin does not imply automatic Git knowledge ingestion. Later work must define reviewed add, update, and delete semantics for synchronizing `knowledge/` into OpenViking.

## Validation boundary

The scaffold validates package installation, patch composition, service health, empty content discovery, local Ollama-based embedding and query planning, remote semantic extraction, and an optional end-to-end Harness turn. Remote credentials remain deployment-specific and stay outside Git.

It also does not claim business authorization. DSH sandbox permissions, OpenViking authentication, and Trader Ops tool policy are separate boundaries; all three must be configured before untrusted or production access.

## Alternatives considered

- Commit a complete `ov.conf` template with guessed model providers. Rejected because the required VLM, embedding model, endpoints, and credentials vary by environment, and a plausible-looking template would encourage invalid or insecure deployments.
- Run Ollama inside Docker Desktop on macOS. Rejected because that path cannot use Apple Metal acceleration and duplicates model state inside the container environment; native Ollama keeps inference local while the container remains replaceable.
- Point the direct `deepseek-official` adapter at a third-party relay. Rejected because that route owns DeepSeek-specific wire behavior; the existing `llm-pi-ai` declared-provider path is the supported abstraction for an OpenAI-compatible service.
- Let the OpenViking installer select the latest plugin on every host. Rejected for the scaffold because remote deployments need reproducible package resolution; version upgrades should be reviewed explicitly.
- Add placeholder `SKILL.md` and knowledge documents. Rejected because empty discovery is a supported state and fake content would blur the boundary between infrastructure readiness and business readiness.
- Treat descriptive policy YAML as sufficient on its own. Rejected because configuration without an execution hook creates a false security boundary; the scaffold instead loads a tested Harness plugin and separately documents the MCP server's final authorization responsibility.

## Consequences

Developers can bring up and validate the integration before business content exists, and operators have an explicit remote filesystem layout and startup sequence. Adding a skill later requires only a valid direct-child `SKILL.md`; adding knowledge still requires a separately reviewed ingestion path.

OpenViking may derive semantic metadata from a filename even when its file is empty. Deployment validation therefore does not count empty or whitespace-only Markdown, and ingestion must reject it rather than creating misleading searchable resources.

A 65,536-token declared context avoids immediate compaction from the current Harness system prompt and tool catalog. Operators must revalidate capacity, latency, and tool behavior when changing the remote model.

A remote relay moves every model-visible prompt, recalled memory item, tool description, and user message outside the controlled host. Operators must approve endpoint ownership, model routing, retention, and data-processing terms before the route handles restricted data.

The host bootstrap pins Node, pnpm, Ollama, its two model ids, and the OpenViking image digest. Docker Engine follows Docker's signed Debian apt repository; an upgrade therefore requires reviewing the resolved Docker package versions as well as the explicitly pinned artifacts.

The Harness-side tool-name/environment boundary is active and explicitly denies OpenViking permanent-forget. The remaining unfinished area is the real Trader Ops MCP service and its trusted identity, resource/argument authorization, durable approval, and audit stores. The private-LAN proxy carries a bearer URL token and session cookie over plaintext HTTP, so its network and users stay trusted until that final service boundary and a TLS terminator exist.

Pinning plugin version `0.3.0` improves repeatability but creates an intentional maintenance task: any Harness or OpenViking upgrade must re-check Node requirements, peer dependencies, effective configuration, and health/readiness behaviour.
