# query-strategy Skill

[English](README.md) | 中文

本目录承载“查询产品策略”的完整 Skill bundle。Skill 用知识检索解释字段，用 MCP tool 获取当前绑定或历史切换记录，并清楚区分两类结果。

## 应该放在这里

- 当前策略与历史策略查询的意图识别和参数规则。
- 产品消歧、时间范围默认值、排序和结果摘要要求。
- 只读 Tool 白名单及数据新鲜度说明。

## 不应该放在这里

- 策略概念、切换业务规则的长篇说明；放在 `../../knowledge/business/`。
- 策略切换、启停或修改配置的步骤。
- 历史查询结果的静态副本。
- SQL、数据库密码或绕过 MCP 的访问方式。

## `SKILL.md` 示例

```markdown
---
name: query-strategy
description: Read a product's current strategy or strategy-switch history for a specified time range.
whenToUse: Use when the user asks which strategy a product uses or requests its strategy history.
user-invocable: true
---

# Query Strategy

1. Extract the product code and decide whether the user needs the current binding or historical records.
2. Call `get_product_strategy` for the current binding or `query_strategy_history` for historical records.
3. When the user omits a historical range, use the deployment default and state that range in the output.
4. Sort history newest first and show `old_strategy → new_strategy`, operator, and timestamp.
5. Return the live data source and query time; never call a write tool.
```
