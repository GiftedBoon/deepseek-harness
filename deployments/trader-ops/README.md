# Trader Ops agent deployment resources

English | [中文](README.zh.md)

This directory contains the business knowledge, executable skills, and governance policies used by the Trader Ops team's DeepSeek Harness deployment. Git manages them together, but different runtime components load them and they do not replace one another.

```text
deployments/trader-ops/
├── config/       # DSH, OpenViking, and systemd configuration
├── knowledge/    # Facts, rules, and operational context indexed by OpenViking
├── policies/     # Enforced tool access plus future identity/approval contracts
├── scripts/      # Profile bootstrap and deployment verification scripts
├── skills/       # Task instructions loaded in full by Harness Skill Loader
├── ARCHITECTURE.md
├── DEVELOPMENT.md
└── DEPLOYMENT.md
```

The scaffold supports zero knowledge documents and zero `SKILL.md` files. Read the [architecture](ARCHITECTURE.md), then follow either [local development](DEVELOPMENT.md) or [remote deployment](DEPLOYMENT.md).

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
