# Trader Ops deployment architecture

English | [中文](ARCHITECTURE.zh.md)

This scaffold completes the runtime wiring before business knowledge or production skills exist. It validates component boundaries, configuration composition, persistence, and remote startup; it does not imply that the deployment already has trading capabilities.

## Components and data flow

```text
User / Web UI
      |
      v
DeepSeek Harness (web profile)
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
  +-- future MCP client ----> Trader Ops MCP server ----> DB / API / NAS
           disabled by default
```

`knowledge/` is the version-controlled source of truth for future OpenViking ingestion. The OpenViking plugin provides session memory, recall, and a bridge for related MCP tools, but it does not scan this Git directory automatically. A reviewed ingestion pipeline, OpenViking Studio, or `mcp__openviking__add_resource` must submit content explicitly.

`skills/` is discovered by an additional `@deepseek-ai/dsh-skill-filesystem` provider. Each `README.md` is documentation only. Only `<skill-name>/SKILL.md` enters the catalog and is loaded in full by Harness Skill Loader when a task matches.

`policies/tool-access.yaml` is loaded by `@deepseek-ai/dsh-experimental-quant-tool-policy`. It enforces environment/tool rules through `tools/pre-execute` and repeats its fail-closed boundary through `ctx.tools.guard()`. `risk-levels.yaml` and `approvals.yaml` remain design contracts until trusted identity and approval stores exist.

## Connected and unconnected capabilities

| Capability | Current state | Detail |
|---|---|---|
| OpenViking service | Deployable | Docker Compose, persistence, and health checks are defined |
| OpenViking DSH plugin | Installable | Pinned to `@openviking/dsh-memory-plugin@0.3.0` |
| Trader Ops skill root | Configured | An empty root is valid; adding `SKILL.md` enables discovery |
| Automatic Git knowledge ingestion | Not implemented | Reviewable add, update, and delete semantics remain required |
| Trader Ops MCP | Template, disabled | Enable the example patch only after the real service exists |
| Harness tool policy | Experimental, enforced | First-match allow/ask/deny plus default deny and an anti-bypass guard |
| Identity, resource authorization, audit | Not implemented | The Trader Ops MCP server and approval store must enforce them |

## Security boundaries

- OpenViking binds to `127.0.0.1:1933` by default. Cross-host access must use a private network or a TLS reverse proxy instead of exposing the port directly.
- DSH starts with `DSH_PERMISSION_MODE=read-only`. This value controls the local Harness sandbox; it is not a business tool guard.
- The OpenViking API key enters through the environment only. OpenViking requires `server.root_api_key` in its own configuration when it listens beyond loopback.
- `mcp__openviking__forget` permanently deletes data and is explicitly denied by the current policy. OpenViking must still authenticate and authorize direct clients independently of Harness.
- Dynamic business state must come from live MCP/API queries. Retrieved Markdown must not substitute for current state.

## Configuration layers

```text
Built-in DSH web profile
  + installed OpenViking bundle patch
  + config/dsh/trader-ops.patch.yml
  + (future, optional) config/dsh/trader-ops-mcp.patch.yml
```

A later patch replaces the complete `config` of a matching row; it does not deep-merge that object. Any change to `openviking-memory-runtime` must retain every field that still needs to apply, then use `--dump-config` to inspect the final composition.
