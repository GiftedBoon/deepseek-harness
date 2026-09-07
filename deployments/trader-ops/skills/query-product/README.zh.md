# query-product Skill

[English](README.md) | 中文

本目录承载“查询产品”的完整 Skill bundle。实现时新增 `SKILL.md`，由 Harness Skill Loader 按需完整加载，用实时 Tool 结果回答产品状态问题。

## 应该放在这里

- 产品标识解析、消歧、查询、结果校验和展示步骤。
- 允许使用的只读 tools 及缺失/多结果处理。
- 查询结果需要包含的时间、来源和字段。

## 不应该放在这里

- 产品术语和字段口径的唯一说明；放在 `../../knowledge/business/`。
- 产品数据快照或硬编码的当前状态。
- 修改产品、策略或生产配置的操作。
- 查询 Tool 的具体数据库连接实现。

## `SKILL.md` 示例

```markdown
---
name: query-product
description: Query product metadata and current state without changing business data.
whenToUse: Use when the user asks whether a product exists or asks for its metadata or current state.
user-invocable: true
---

# Query Product

1. Extract the product code from the request; ask when it is missing and never guess.
2. Call `get_product`; never substitute a historical knowledge-base value for a live query.
3. For no result, state the source and query conditions; for multiple results, disambiguate first.
4. Return product code, name, state, environment, query time, and data source.
5. This skill is read-only and must not call a create, update, delete, or switch tool.
```
