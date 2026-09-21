---
name: database-query
description: Inspect the approved Trader Ops ClickHouse and MSSQL connections and run bounded, audited, read-only SQL for live analysis.
whenToUse: Use when a user asks for current database-backed facts, table discovery, schema inspection, aggregation, comparison, or diagnostic analysis.
user-invocable: true
---

# 受控数据库查询

本 Skill 使用现有 `bssh-ops-remote` MCP 服务中的数据库工具。所有查询都经过后端 SQL AST 校验、连接白名单、行数、字节数、超时限制和审计；不要用 shell、bssh_ops 远程命令或 OpenViking 代替实时数据库查询。

## 工具

- `mcp__bssh-ops-remote__db_list_connections`：查看当前允许使用的连接别名。
- `mcp__bssh-ops-remote__db_list_tables`：按名称发现表。
- `mcp__bssh-ops-remote__db_describe_table`：查看字段、类型、可空性和默认值。
- `mcp__bssh-ops-remote__db_run_query`：执行一条受控 SELECT/CTE；默认 500 行，最多 5000 行。

## 工作流

1. 用户没有明确连接名时，先列出连接并根据用途选择；无法判断时向用户确认，不能猜。
2. 表名或字段不确定时，先列出表并查看 schema，再生成 SQL。不得臆造表、字段或枚举值。
3. 查询只选择回答问题所需的列和时间范围，优先聚合；除探查少量样例外避免 `SELECT *`。
4. 首次查询使用较小的 `max_rows`。只有结果确实需要且用户问题要求时才扩大，不能为了绕过截断反复分页拉取整表。
5. 只允许单条 SELECT/CTE。工具拒绝写操作、跨库、外部表函数或多语句时，解释限制并停止；不得改用其他工具绕过。
6. 根据返回的列定义解释数据。`truncated=true` 时明确说明结果不完整，不得据此声称已覆盖全量。
7. 回答包含连接别名、筛选/时间范围、关键口径、是否截断和 `query_id`。不要输出与问题无关的敏感明细。

## 数据与失败处理

- 数据库结果是本次实时读取；知识库内容只能解释业务含义，不能替代实时值。
- 不把查询结果、实时状态或大批量明细写入 OpenViking。
- 连接失败、超时、服务繁忙或审计不可用时报告准确错误并停止。可以缩小时间范围或减少列数后重试一次，但不能取消安全限制。
- 查询结果和工具错误中如出现疑似密码、令牌或连接串，不要在回复中复述。
