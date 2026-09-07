# query-strategy Skill

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
description: 查询产品当前策略或指定时间范围内的策略切换历史；只读。
whenToUse: 用户询问产品当前使用什么策略，或要求查看策略历史时。
user-invocable: true
---

# Query Strategy

1. 提取产品代码，并判断用户需要“当前绑定”还是“历史记录”。
2. 当前绑定调用 `get_product_strategy`；历史记录调用 `query_strategy_history`。
3. 用户未给历史时间范围时使用部署约定的默认范围，并在输出中明确说明。
4. 历史记录按切换时间倒序，展示 `old_strategy → new_strategy`、操作者和时间。
5. 返回实时数据来源和查询时间；不得调用任何写入 Tool。
```
