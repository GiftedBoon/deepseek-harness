---
type: glossary
domain: trading
owner: bwpan
status: approved
updated_at: "2026-09-21"
tags: [product, colo, metric, field-meaning]
---

# 业务术语表

本表收录跨产品通用的业务术语与计量口径。产品的分类维度、业务线含义与多空产品规则单独维护在 [产品分类与业务线](product-taxonomy.md)，本表不重复其内容。

## 术语

| 术语 | 定义 |
|---|---|
| 产品 | 私募的各类基金产品；数据库表中对应的列名通常为 `product`、`production`。 |
| Colo | 交易机。名字格式通常为「券商简写-中心-编号」，例如 `cf-sz-1`：`cf` 表示券商华鑫，`sz` 表示中心是深圳，`1` 是编号。极个别机器不遵循该格式，例如 `cfipasz1`、`cfipash1` 表示券商平安（`pa`）的深圳、上海机器。 |
| return | 通常指收益率，而不是一个收益金额。 |
| pnl | Profit and loss，即盈亏；与 `return` 一样通常指收益率。 |
| mv | 市值。 |

## 命名与计量口径

- 产品归属文件的规范写法是 `Prod_Infor`，字段名大小写以该文件为准。
- `return` 与 `pnl` 表达的是比率口径，不是金额；需要金额时必须回到原始字段确认口径。

## 权威来源

- 术语与计量口径的评审负责人：bwpan
- 产品与分类的**当前归属**是动态状态，只能通过 `mcp__bssh-ops-remote__list_colos_for_index` 或 `mcp__bssh-ops-remote__list_live_colos` 实时查询，不写入本表。

## 相关资料

- [产品分类与业务线](product-taxonomy.md)
