# query-product Skill

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
description: 查询产品基础信息和当前状态；只读，不修改任何业务数据。
whenToUse: 用户询问某个产品是否存在、基础属性或当前状态时。
user-invocable: true
---

# Query Product

1. 从请求中提取产品代码；缺失时向用户询问，不猜测。
2. 调用 `get_product`，禁止用知识库中的历史值代替实时查询。
3. 无结果时明确说明数据源与查询条件；多结果时先消歧。
4. 返回产品代码、名称、状态、所属环境、查询时间和数据来源。
5. 本 Skill 只读，不得调用任何 create、update、delete 或 switch tool。
```
