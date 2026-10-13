# Trader Ops agent deployment resources

English | [中文](README.zh.md)

This directory contains the business knowledge, executable skills, and governance policies used by the Trader Ops team's DeepSeek Harness deployment. Git manages them together, but different runtime components load them and they do not replace one another.

```text
deployments/trader-ops/
├── config/       # DSH, OpenViking, and systemd configuration
├── knowledge/    # Facts, rules, and operational context indexed by OpenViking
├── policies/     # Enforced tool access plus future identity/approval contracts
├── remote-deployment/ # Validated remote deployment record
├── scripts/      # Profile bootstrap and deployment verification scripts
├── skills/       # Task instructions loaded in full by Harness Skill Loader
├── templates/    # Obsidian authoring templates excluded from knowledge ingestion
├── ARCHITECTURE.md
├── DEVELOPMENT.md
└── DEPLOYMENT.md
```

The scaffold supports zero knowledge documents and zero `SKILL.md` files. Read the [architecture](ARCHITECTURE.md), then follow either [local development](DEVELOPMENT.md) or [remote deployment](DEPLOYMENT.md).

The current remote verification snapshot is in [remote-deployment/](remote-deployment/README.md). It records the deployed revision, service endpoints, health checks, and the WeCom Session recreation acceptance sequence without storing credentials or message content.

## What belongs here

- Shared agent runtime material that the team reviews and versions.
- Markdown, YAML, and supporting skill resources directly related to business knowledge, task execution, or security governance.
- Example configuration that contains no keys, tokens, or personal data.

## What does not belong here

- MCP server, database client, or SSH executor implementation; place that code in its owning package or integration.
- Live database records, monitoring snapshots, or changing runtime state; the agent reads these through MCP or an API.
- API keys, passwords, private keys, or production connection strings.
- Harness core source or project documentation unrelated to the Trader Ops deployment.

## Loading relationships

Profile bootstrap applies reviewed compatibility patches to OpenViking `0.3.0`: memory messages use the same producer source kind as migrated history, profile and recall recognition use that kind, and capture accepts only human, model, or tool messages. Synthetic context is not saved as human input. Deployment verification refuses missing patches; a different package version or changed reviewed source stops bootstrap without rewriting Session history.

Profile recognition reads the current derived message history. A profile still present in the model context suppresses another startup injection; a profile removed by compaction can be refreshed.

`bootstrap-profile.sh` writes the reviewed WeCom composition as a `dsh-agent-preset` declaration in `preset.cordis.yml`. The deployment provider validates and registers it after its Host dependencies are available; the WeCom channel requires that provider's readiness service. Removing the provider stops the channel. `verify-deployment.sh` validates the declaration's `config.plugins` against the reviewed Agent composition, excluding the host preset registration. Schedule is loaded from the optional `schedule-bundle` patch, which delivers due prompts through the Host even when the target Session is not live.

```text
knowledge/*.md  ----submit/sync---> OpenViking ----retrieved fragments---> Agent context
skills/*/SKILL.md ----------------> Harness Skill Loader ----full content---> Agent
policies/*.yaml ------------------> Policy / Hook / Tool Guard ----allow, approve, or deny---> Tool
```

`deployments/trader-ops/skills` is not a default filesystem skill provider root. `config/dsh/trader-ops.patch.yml` adds it to `customSkillDirs` through a dedicated provider:

```yaml
- insert:
    - id: trader-ops-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: trader-ops
        includeDefaultRoots: false
        customSkillDirs:
          - ./deployments/trader-ops/skills
```

Knowledge synchronization can have its own configuration, for example:

```yaml
knowledge:
  source: ./deployments/trader-ops/knowledge
  provider: openviking
  include: "**/*.md"
  exclude:
    - "**/README.md"
    - "**/README.zh.md"
```

This knowledge synchronization block is a future ingestion contract, not a built-in Harness or OpenViking configuration field. The OpenViking DSH plugin does not scan the Git directory automatically; the eventual adapter must index `knowledge` and exclude `skills` and `policies`.

`tool-access.yaml` is loaded by the experimental policy plugin in the DSH patch and fails closed on unmatched tools. `risk-levels.yaml` and `approvals.yaml` remain design contracts; trusted identity, resource authorization, durable approvals, and complete audit must be implemented at the business MCP service boundary.

## Automatic pre-open watch

The Agent creates executable Schedule tasks in the receiving WeCom conversation by following [preopen-watch](skills/preopen-watch/SKILL.md). Loading the Skill does not schedule anything. `schedule_task_create` executes the saved instruction; `schedule_create` remains a reminder. The existing intelligent bot sends scheduled results through the originating conversation's durable outbox without a webhook or another bot. Task routing uses that conversation, not `TRADER_OPS_PREOPEN_CHAT_ID`.

The daily entry runs at 23:40 in `Asia/Shanghai` and checks the next natural date with the trading calendar. Sunday evening can target Monday; Friday evening does not skip to Monday. Estimated or failed calendar results cannot authorize production checks. The Agent creates a 60-second nightly recheck expiring at target-date 00:30 and a separate non-expiring cutoff task, records their actual task ids, and reads the configuration back. Every execution checks persisted completion first, so queued late ticks cannot restart a completed night. Execution can be delayed by downtime or a busy Agent; the service must remain running.

The Skill owns completion rules, read-only stall triage, output limits, and evidence handling. Successful previous-batch comparisons with zero missing rows are omitted. Three consecutive fresh, complete unchanged pending sets trigger triage; identical stale or repeated batches do not advance the count. Saved process `run_id` values are polled rather than redispatched, and each colo retains separate evidence. Undated or timezone-ambiguous log lines do not establish a current startup failure. The cutoff reports unfinished nights even when no valid batch arrived; all automatic actions remain read-only.

Workflow state uses the session-scoped bounded `schedule_state_read` and compare-and-swap `schedule_state_write` tools. It contains settings, the current target date, task ids, completion status, monitoring summaries, and minimal evidence. It contains neither raw logs nor credentials. The Schedule execution record and the bot delivery record are separate: Agent completion does not prove WeCom delivery. Silent checks produce no final text; the channel does not send an empty-reply notice for scheduled executions.

The [bssh MCP patch](config/dsh/trader-ops-bssh-ops-mcp.patch.yml) retains the [legacy watcher](scripts/preopen-watch-plugin.mjs) behind `TRADER_OPS_PREOPEN_WATCH_ENABLED=1` for controlled cutover. Its existing state and notification route remain available until acceptance passes. Do not run it alongside Agent-owned pre-open tasks. Follow the [cutover procedure](DEPLOYMENT.md); verification requires real task ids and delivery evidence, not just an installed Skill. To move reports to another group, stop the workflow in the original conversation and create it in the new allowlisted conversation.
