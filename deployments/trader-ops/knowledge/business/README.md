# Business：业务概念与规则

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

# 策略切换规则

一个产品同一时刻只能有一个生效策略。目标策略必须属于该产品允许的策略集合。

## 前置条件

- 产品处于允许切换的业务时段。
- 当前策略和目标策略均通过实时接口确认。
- 高风险切换已取得当班负责人审批。

## 权威数据源

- 当前绑定：`get_product_strategy`
- 可选策略：`list_product_strategies`

本文只定义规则，不记录某产品当前策略，也不直接授权任何工具调用。
```
