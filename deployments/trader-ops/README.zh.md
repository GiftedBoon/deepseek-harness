# Trader Ops Agent 部署资源

[English](README.md) | 中文

本目录保存 Trader Ops 团队部署 DeepSeek Harness 时使用的业务知识、可执行 Skill 和治理策略。它们可以一起由 Git 管理，但由不同的运行时组件加载，不能互相替代。

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

当前骨架支持知识文档和 `SKILL.md` 都为零的状态。先阅读[架构说明](ARCHITECTURE.md)，然后按[本地开发步骤](DEVELOPMENT.md)或[远程部署步骤](DEPLOYMENT.md)操作。

## 应该放在这里

- 团队共享、需要评审和版本追踪的 Agent 运行资料。
- 与业务知识、任务执行流程或安全治理直接相关的 Markdown、YAML 及 Skill 配套资源。
- 不含密钥、令牌和个人信息的示例配置。

## 不应该放在这里

- MCP Server、数据库客户端或 SSH 执行器的实现代码；它们应放在对应 package 或 integration 中。
- 数据库实时记录、监控快照和不断变化的运行状态；Agent 应通过 MCP 或 API 实时读取。
- API key、密码、私钥、生产连接串等秘密。
- Harness 核心源码或与 Trader Ops 团队部署无关的项目文档。

## 加载关系

```text
knowledge/*.md  ----submit/sync---> OpenViking ----retrieved fragments---> Agent context
skills/*/SKILL.md ----------------> Harness Skill Loader ----full content---> Agent
policies/*.yaml ------------------> Policy / Hook / Tool Guard ----allow, approve, or deny---> Tool
```

`deployments/trader-ops/skills` 不是文件系统 Skill Provider 的默认目录。`config/dsh/trader-ops.patch.yml` 通过独立提供方把它加入 `customSkillDirs`：

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

知识同步可以独立配置，例如：

```yaml
knowledge:
  source: ./deployments/trader-ops/knowledge
  provider: openviking
  include: "**/*.md"
  exclude:
    - "**/README.md"
    - "**/README.zh.md"
```

以上知识同步配置是待实现的入库约定，不代表 Harness 或 OpenViking 当前内置的配置字段。OpenViking DSH 插件不会自动扫描 Git 目录；实际接入器应把 `knowledge` 当作可检索资料，把 `skills` 和 `policies` 排除在知识索引之外。

`tool-access.yaml` 已由 DSH patch 中的实验策略插件加载，并对未匹配工具失败关闭。`risk-levels.yaml` 和 `approvals.yaml` 仍是设计约定；可信身份、资源授权、持久审批与完整审计必须在业务 MCP 服务边界实现。
