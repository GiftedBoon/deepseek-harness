# Trader Ops Agent 部署资源

本目录保存 Trader Ops 团队部署 DeepSeek Harness 时使用的业务知识、可执行 Skill 和治理策略。它们可以一起由 Git 管理，但由不同的运行时组件加载，不能互相替代。

```text
deployments/trader-ops/
├── knowledge/   # OpenViking 索引和检索的事实、规则与操作背景
├── skills/      # Harness Skill Loader 按需完整加载的任务说明
└── policies/    # 权限、审批、风险等级和 tool guard 规则
```

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
knowledge/*.md  ──提交/同步──> OpenViking ──检索片段──> Agent 上下文
skills/*/SKILL.md ───────────> Harness Skill Loader ──完整内容──> Agent
policies/*.yaml ─────────────> Policy / Hook / Tool Guard ──允许、审批或拒绝──> Tool
```

`deployments/trader-ops/skills` 不是文件系统 Skill Provider 的默认目录。部署配置需要把它加入 `customSkillDirs`：

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - ./deployments/trader-ops/skills
- name: '@deepseek-ai/dsh-tool-skill'
```

知识同步可以独立配置，例如：

```yaml
knowledge:
  source: ./deployments/trader-ops/knowledge
  provider: openviking
  include: "**/*.md"
  exclude:
    - "**/README.md"
```

以上 OpenViking 配置是建议的部署格式示例，不代表 Harness 当前内置的配置字段。实际接入器应把 `knowledge` 当作可检索资料，把 `skills` 和 `policies` 排除在知识索引之外。
