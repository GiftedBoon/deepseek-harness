# Trader Ops deployment architecture

English | [中文](ARCHITECTURE.zh.md)

This scaffold completes the runtime wiring before business knowledge or production skills exist. It validates component boundaries, configuration composition, persistence, and remote startup; it does not imply that the deployment already has trading capabilities.

## Components and data flow

```text
User / Web UI
      |
      v
DeepSeek Harness (web profile)
  |-- Main LLM -----------> selected OpenAI-compatible route via llm-pi-ai
  |-- Skill Loader --------> deployments/trader-ops/skills/*/SKILL.md
  |                          Loads the complete file; zero is valid
  |
  |-- Tool Policy ---------> tools/pre-execute + tools.guard()
  |                          First match; unmatched calls are denied
  |
  |-- OpenViking plugin ---> OpenViking HTTP service ---> persistent directory
  |        |                       |
  |        | recall                +--> future knowledge/*.md input
  |        + session capture            currently empty is valid
  |
  +-- bssh_ops MCP client ---> bssh_ops HTTP server ------> colo hosts
           disabled by default
```

`knowledge/` is the version-controlled source of truth for OpenViking resources. The OpenViking plugin provides session memory, recall, and a bridge for related MCP tools, but it does not scan this Git directory. The operator-run `scripts/sync-knowledge.mjs` publisher validates approved documents, plans content-hash changes, and submits each changed file to a stable `viking://resources/trader-ops/knowledge/...` URI. Publication is explicit and stale resources are reported without deletion.

`skills/` is discovered by an additional `@deepseek-ai/dsh-skill-filesystem` provider. Each `README.md` is documentation only. Only `<skill-name>/SKILL.md` enters the catalog and is loaded in full by Harness Skill Loader when a task matches.

`policies/tool-access.yaml` is loaded by `@deepseek-ai/dsh-experimental-quant-tool-policy`. It enforces environment/tool rules through `tools/pre-execute` and repeats its fail-closed boundary through `ctx.tools.guard()`. `risk-levels.yaml` and `approvals.yaml` remain design contracts until trusted identity and approval stores exist.

## Connected and unconnected capabilities

| Capability | Current state | Detail |
|---|---|---|
| OpenViking service | Deployable | Docker Compose, persistence, and health checks are defined |
| OpenViking DSH plugin | Installable | Pinned to `@openviking/dsh-memory-plugin@0.3.0` |
| AIHubMix model | Optional, validated | `llm-pi-ai` serves Harness and OpenViking semantic extraction through an environment-provided endpoint and key |
| Trader Ops skill root | Configured | An empty root is valid; adding `SKILL.md` enables discovery |
| Git knowledge publishing | Operator-controlled | Dry-run planning plus approved-document add/update; stale resources are never deleted |
| bssh_ops MCP | Optional, disabled by default | Enable `trader-ops-bssh-ops-mcp.patch.yml` with a root-owned API key |
| Schedule reminders | Enabled | The Web service applies the Schedule overlay and policy permits its session-local management tools; a due prompt never executes directly |
| WeCom scheduled bssh_ops execution | Enabled with WeCom | Durable actions accept `ps_check`, any current quick-command key, or an exact syntax-checked and user-confirmed custom shell for any non-empty target; dispatch still traverses tool policy, and bssh_ops authorizes the exact target |
| Harness tool policy | Experimental, enforced | First-match allow/ask/deny plus default deny and an anti-bypass guard |
| Identity, resource authorization, audit | Not implemented | The Trader Ops MCP server and approval store must enforce them |

## Security boundaries

- OpenViking binds to `127.0.0.1:1933` by default. Cross-host access must use a private network or a TLS reverse proxy instead of exposing the port directly.
- AIHubMix receives all model-visible prompts, recalled memory, tool descriptions, and user input. Its endpoint, selected model, retention policy, and data-processing terms require review before restricted data is allowed.
- Local Ollama binds to `127.0.0.1:11434`; Docker Desktop reaches its embedding and query-planner models through `host.docker.internal`.
- On the Debian MVP, native Ollama binds only to the Docker bridge gateway. Compose maps `host.docker.internal` to that gateway, while Harness and OpenViking publish only loopback ports for an SSH tunnel.
- DSH starts with `DSH_PERMISSION_MODE=read-only`. This value controls the local Harness sandbox; it is not a business tool guard.
- OpenViking credentials enter through the environment only. `OPENVIKING_ROOT_API_KEY` administers accounts and matches `server.root_api_key`; Harness uses the narrower tenant `OPENVIKING_API_KEY` for data access.
- `mcp__openviking__forget` permanently deletes data and is explicitly denied by the current policy. OpenViking must still authenticate and authorize direct clients independently of Harness.
- Memory also enters OpenViking without a tool call: the `@openviking/dsh-memory-plugin` session capture writes each user and assistant message into the session and commits it at `commitTokenThreshold` or on session disposal, so the tool policy that gates `add_resource`, `write`, `remember`, and `edit` never sees that path. `captureToolResults: false` keeps tool results out of the captured stream, while an assistant reply that repeats their content is still captured.
- Dynamic business state must come from live MCP/API queries. Retrieved Markdown must not substitute for current state.

## Configuration layers

```text
Built-in DSH web profile
  + installed OpenViking bundle patch
  + config/dsh/trader-ops.patch.yml
  + (optional) config/dsh/trader-ops-aihubmix.patch.yml
  + (optional) config/dsh/trader-ops-bssh-ops-mcp.patch.yml
  + apps/cli/config/examples/schedule/cordis.yml
```

A later patch replaces the complete `config` of a matching row; it does not deep-merge that object. Any change to `openviking-memory-runtime` must retain every field that still needs to apply, then use `--dump-config` to inspect the final composition.

The Debian deployment separates root-owned host and secret configuration from a non-root immutable release build. `bootstrap-debian-host.sh` owns system packages, service users, persistent directories, and the restricted Ollama listener; `install-debian-release.sh` owns exact-revision checkout and build; `configure-debian-runtime.sh` owns mode-`0600` secrets, OpenViking tenant creation, Profile bootstrap, and systemd activation.
