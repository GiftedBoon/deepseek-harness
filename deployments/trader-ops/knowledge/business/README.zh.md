# Business：业务概念与规则

[English](README.md) | 中文

本目录说明业务对象是什么、对象之间如何关联，以及哪些业务约束长期成立。OpenViking 应索引这些文档，让 Agent 在回答或执行前获得业务语义。

## 应该放在这里

- product、strategy、account 等术语定义。
- 产品与策略的关系、交易时段和状态转换规则。
- 字段含义、口径、边界条件和权威数据来源。
- 规则负责人、审核状态和更新时间。

## 不应该放在这里

- 查询数据库或切换策略的逐步指令；放在 `../../skills/`。
- 服务器地址、部署拓扑和组件运维信息；放在 `../systems/`。
- 故障处置步骤；放在 `../runbooks/`。
- 产品当前绑定策略等实时结果。

## 示例：`strategy-switch-rule.md`

```markdown
---
type: business-rule
domain: trading
owner: trading-operations
status: approved
risk_level: high
tags: [product, strategy, switch]
updated_at: 2026-09-07
---

# Strategy switch rules

A product can have only one active strategy at a time. The target strategy must belong to that product's allowed strategy set.

## Preconditions

- The product is within a business window that permits switching.
- Live interfaces confirm both the current and target strategies.
- The duty owner has approved a high-risk switch.

## Authoritative data sources

- Current binding: `get_product_strategy`
- Allowed strategies: `list_product_strategies`

This document defines rules only. It neither records a product's current strategy nor authorizes any tool call.
```
