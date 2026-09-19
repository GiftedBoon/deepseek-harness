---
name: pre-open-status-check
description: Check whether the latest ProductionMonitorData snapshot has reset every product PnLratio to zero before market opening. Use for pre-open reset, pre-open completion, or abnormal product checks.
whenToUse: Use when a user asks whether pre-open data reset has completed, whether every product PnLratio is zero, or which products block the pre-open check.
user-invocable: true
---

# 预开启状态检查

本 Skill 固定检查 ClickHouse `trade` 数据库中 `ProductionMonitorData` 的最新一批数据。它只判断最新已存储快照的重置状态，不把非零值擅自归因于“预开启未结束”或“未开启产品异常”。

## 检查步骤

1. 调用 `mcp__bssh-ops-remote__db_run_query`，连接使用 `trade-clickhouse`，`max_rows` 使用 10，执行以下汇总 SQL：

```sql
SELECT
    max(CreateTime) AS latest_create_time,
    count() AS total_rows,
    countIf(PnLratio = 0) AS zero_rows,
    countIf(PnLratio != 0) AS nonzero_rows,
    countIf(isNull(PnLratio)) AS null_rows
FROM ProductionMonitorData
WHERE CreateTime = (
    SELECT max(CreateTime)
    FROM ProductionMonitorData
)
```

2. 按以下互斥规则判定：
   - `total_rows = 0`：`无法判断`。表中没有可检查的最新批次，不能报告成功。
   - `zero_rows = total_rows` 且 `nonzero_rows = 0` 且 `null_rows = 0`：`重置成功`。最新一批所有产品的 `PnLratio` 都精确等于 0。
   - 其他情况：`未结束或异常`。最新一批存在非零或 NULL，不进一步猜测根因。

3. 只有判定为 `未结束或异常` 时，再调用一次 `mcp__bssh-ops-remote__db_run_query`，连接仍使用 `trade-clickhouse`，`max_rows` 使用 5000，执行以下明细 SQL：

```sql
SELECT
    `NAME` AS product,
    PnLratio,
    CreateTime
FROM ProductionMonitorData
WHERE CreateTime = (
    SELECT max(CreateTime)
    FROM ProductionMonitorData
)
  AND (PnLratio != 0 OR isNull(PnLratio))
ORDER BY `NAME`
```

4. 明细结果 `truncated=true` 时，说明异常产品清单不完整，不要重复分页拉取全表。汇总判定仍以第一条查询的计数为准。

## 输出

回答必须包含：判定状态、`latest_create_time`、总产品行数、零值行数、非零行数、NULL 行数、两次查询各自的 `query_id`（未执行明细查询时只报告汇总查询 id），以及查询是否截断。

判定为 `重置成功` 时使用“最新已存储批次的 PnLratio 已全部重置为 0”，不要仅写“预开启成功”。判定为 `未结束或异常` 时列出异常产品及其 `PnLratio`，并说明仅凭该表无法区分预开启仍在进行和未开启产品异常。始终展示最新批次时间；该时间是否足够新需要独立的业务时效阈值，本 Skill 不自行假设。

数据库拒绝、超时、审计不可用、返回列缺失或计数关系不满足 `total_rows = zero_rows + nonzero_rows + null_rows` 时，报告 `检查失败`，不要给出业务成功结论。
