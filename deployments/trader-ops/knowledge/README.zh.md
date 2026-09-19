# Knowledge：可检索业务知识

[English](README.md) | 中文

本目录是团队业务知识的 Git 源文件目录。文档经审核后同步到 OpenViking，由 Agent 根据当前问题检索相关片段；它们不会像 Skill 一样被完整、强制加载。

`business/`、`systems/` 和 `runbooks/` 下的知识条目属于部署内容，可以只写中文。普通知识条目不需要创建英文对侧文件或 `.i18n.yaml` 配对记录。各目录的 `README` 仍属于仓库说明，需要保持双语，并且不进入 OpenViking。

## 应该放在这里

- 稳定的业务概念、术语、字段含义和业务规则。
- 系统职责、依赖关系、接口说明和数据来源说明。
- Runbook 的背景、判断依据、排障步骤和恢复验证方法。
- 带有统一 YAML frontmatter、适合切分与检索的 Markdown。

## 不应该放在这里

- 要求 Agent 严格逐步执行的任务流程；应写成 `../skills/<name>/SKILL.md`。
- 权限、审批和工具阻断规则；应放在 `../policies/`。
- 当前策略、当天状态、实时日志等动态数据；应通过 MCP/API 查询。
- 未审核的临时经验或包含秘密的原始数据。

## 模板

Obsidian 从 OpenViking 入库根目录之外的 `../templates/knowledge` 读取本部署的纯中文模板。请按目标知识目录选择模板，替换所有 `TODO`，在评审期间保持 `draft` 状态，并只在负责人批准后修改状态。

- Business：[业务规则](../templates/knowledge/business-rule.md)和[术语表](../templates/knowledge/business-glossary.md)。
- Systems：[系统概览](../templates/knowledge/system-overview.md)和[数据源](../templates/knowledge/data-source.md)。
- Runbooks：[故障处置](../templates/knowledge/incident-runbook.md)和[受控变更](../templates/knowledge/change-runbook.md)。

## 发布

发布器只读取 `business/`、`systems/` 和 `runbooks/` 下的非空 Markdown。它会排除目录 README、忽略 `draft` 条目；`approved` 条目缺少 `type`、`domain`、`owner`、`updated_at`、非空 `tags` 或完整正文时会被拒绝。知识文件名使用小写 ASCII slug，使 Git 路径能够稳定映射到 OpenViking URI。原始 tag 以及带 `domain:`、`type:`、`owner:` 前缀的命名空间 tag 会一并提交给 OpenViking，用于检索过滤。

默认只生成计划，不进行网络写入：

```bash
node deployments/trader-ops/scripts/sync-knowledge.mjs \
  --state "$DSH_HOME/knowledge-sync/trader-ops.json"
```

审阅计划后，通过环境变量提供租户 API key 并发布变化文件：

```bash
node deployments/trader-ops/scripts/sync-knowledge.mjs \
  --apply \
  --state "$DSH_HOME/knowledge-sync/trader-ops.json"
```

每个文件只在 OpenViking 完成语义处理和向量化后原子记录 checkpoint；发布失败的文件保留原状态条目。状态文件包含源路径、内容 hash、resource URI、task id 和发布时间，但不包含凭据或文档正文。同一状态文件同时只能由一个发布器持有。

被删除或降级的源文件会在每次计划中显示为 `stale`。初版发布器绝不删除 OpenViking resource；删除仍是独立的受评审操作，因为它还可能清理引用该 resource 的 memory。

## 推荐文档格式

```markdown
---
type: business-rule
domain: trading
owner: trading-platform
status: approved
updated_at: 2026-09-07
tags:
  - product
  - strategy
---

# Product and strategy relationship

One product can bind to only one active strategy at a time.

## Data source

Query the current binding through the `get_product_strategy` MCP tool.

## Related material

- [Strategy switch rules](business/strategy-switch-rule.md)
- [Strategy switch runbook](runbooks/switch-strategy.md)
```

Frontmatter 用于 OpenViking 的过滤、权限控制和结果排序。正文写稳定事实；会变化的值只说明权威来源和查询方式，不复制当前值。
