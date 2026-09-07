# Knowledge：可检索业务知识

[English](README.md) | 中文

本目录是团队业务知识的 Git 源文件目录。文档经审核后同步到 OpenViking，由 Agent 根据当前问题检索相关片段；它们不会像 Skill 一样被完整、强制加载。

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
