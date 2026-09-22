---
name: preopen-watch
description: 交易日前夜守护实盘产品预开启。每分钟调用 check_daily_preopen，检查结果有变化就经企业微信机器人播报一次进度，全部开启成功后收尾；连续 3 次检查无变化则把仍未开启的产品作为异常告警。用于每个交易日前一天 23:40 起的定时触发。
---

# 预开启守护（preopen-watch）

## 这个流程是什么

每个交易日的前一天晚上，所有实盘产品会把第二天正式交易的配置更新好、重置各种交易
数据，然后尝试启动。本 skill 负责在那个窗口里守着，确认所有产品都重启成功了，并把
进度和异常发到企业微信。

判据来自 `check_daily_preopen`：重启成功的产品交易数据被重置，`PnLratio` 为 0；还没
重启的产品仍带着上一交易日收盘的 `PnLratio`（非 0），落在返回的 `pending` 里。所以
**`pending_rows` 就是"还没开启的行数"，它归零即全部开启成功**。

### 实测时间线（2026-09-21 夜，务必按这个设置窗口）

| 时刻 | 未开启行数 |
|---|---|
| 23:38 | 1078 |
| 23:39 | 712 |
| 23:40 | 80 |
| 23:41 | **0**（完成） |

两件事直接决定配置：

1. **整个重启扫描只要约 3 分钟**（23:38 → 23:41）。23:40 起跑只能抓到尾巴，正常夜里
   大概只会发出一条"完成"消息。想看到完整进度就把 `WINDOW_START` 提前到 **23:35**
   （推荐）。本 skill 默认按需求写的 23:40。
2. **写入进程在 23:38 前不产出数据**。所以 23:35~23:38 的检查会看到陈旧批次 —— 这
   不是故障，必须静默等待（见下面的 warmup 阶段），绝不能因此告警。

## 触发方式

harness 在窗口内每分钟触发一次本 skill，每次是**独立的一次执行**，状态靠状态文件
延续（不要做成一个跑一小时的长任务：那样进程一崩整夜就没人看着了）。

```
# 交易日前夜（周日到周四）23:40-23:59
40-59 23 * * 0-4
# 跨过午夜继续到 00:30
0-30 0 * * 1-5
```

**这个 cron 不认识节假日。** 它会在长假前夜也触发，但那种夜里写入进程不产出数据，
warmup 阶段会静默退出，不会误告警 —— 代价是节前那几天窗口末尾会发一条"写入进程未
产出"的提示。有交易日历就优先用日历门控。

## 前置条件

- MCP server `bssh-ops` 已挂载，能调 `check_daily_preopen`（在有些 harness 里名字是
  `mcp__bssh-ops-remote__check_daily_preopen`）。该工具**只读**、不连 colo，任何失败都可以
  安全重试。
- 企业微信机器人 webhook 放在环境变量 `WECOM_WEBHOOK_PREOPEN` 里。
  **绝对不要把 webhook 或 key 写进本文件、状态文件、消息正文或日志。**
- 状态文件目录可写（`STATE_DIR`）。

## 配置常量

| 常量 | 默认 | 说明 |
|---|---|---|
| `WINDOW_START` | `23:40` | 起跑时刻。**推荐 23:35**，理由见上面的时间线 |
| `WINDOW_END` | `00:30` | 硬截止。到点仍未完成就发最终告警并收尾 |
| `STALL_REPEATS` | `3` | 同一个未开启集合连续出现这么多次就告警 |
| `FRESH_MAX_AGE_SECONDS` | `180` | `age_seconds` 超过就认为写入进程没在产出 |
| `WARMUP_QUIET_CHECKS` | `5` | warmup 阶段容忍这么多次陈旧检查，全程静默 |
| `WARMUP_DEADLINE` | `23:50` | 过了这个点还是陈旧，就发一条"写入进程未产出" |
| `MAX_DETAIL_ROWS` | `200` | 传给工具的明细上限 |
| `LIST_THRESHOLD` | `30` | 未开启行数不超过这个数就逐条列出，否则只给汇总 |
| `EXPECTED_EXCLUDED` | 见下 | 允许被排除的产品名单 |

`EXPECTED_EXCLUDED`（2026-09-22 实测的 6 个，全是 `Index=LS`）：
`GSLS4`、`JPMLS2`、`MSLS2`、`SHORTMSBOXLS1`、`SHORTMSBOXLS2`、`UBSLS2`

## 工具返回里要用到的字段

`check_daily_preopen(max_detail_rows=200)` 返回：

- `pending_rows` / `pending_products` / `pending` —— **还没开启的**，这是本流程唯一的
  异常类别。
- `ready` —— `pending_rows == 0` 且范围非空，即全部开启成功。
- `total_rows` / `total_products` —— 检查范围（已排除无数据文件的行）。
  `batch_rows` 是排除前的原始行数。
- `no_data_file` / `no_data_file_products` —— **被自动排除的那几个 LS 产品**。
  需求里"除了几个过滤的 LS 产品"由工具自己做掉了，本 skill 只负责核对名单没变。
- `not_reporting` / `not_reporting_rows` —— 有文件但上报卡住（`Time` 落后超过 1 小时）。
  **按约定不算预开启异常**，只在消息里附一句。
- `create_time` / `age_seconds` / `is_today` —— 批次时效。
- `missing_rows` / `previous_batch_compared` —— 与上一批比对出的整行消失。
- `warnings` —— 中文告警文案，可以直接摘进消息。

## 状态文件

`{STATE_DIR}/preopen-watch-{session}.json`。

`session` 取**目标交易日**（本地时间 12:00 之后取次日日期，之前取当日日期），这样
跨午夜前后同一夜用的是同一个键。

```json
{
  "session": "2026-09-22",
  "phase": "warmup",
  "checks": 0,
  "stale_checks": 0,
  "warmup_notified": false,
  "baseline_pending_rows": null,
  "baseline_at": null,
  "last_signature": null,
  "repeat_count": 0,
  "alerted_signature": null,
  "excluded_alerted": false,
  "done": false
}
```

`phase`：`warmup`（等写入进程产出）→ `tracking`（盯进度）→ `done`（已收尾）。

**变化签名** `signature = "{pending_rows}|{pending_products}|{sha1(逐行 NAME|Colo|Exchange 拼接)}"`，
行取工具返回的 `pending` 列表（已按 `Index, NAME, Colo, Exchange` 排序）。

> 已知边界：`pending` 超过 `MAX_DETAIL_ROWS` 时列表被截断，签名只覆盖前 200 行。此时
> 仍有 `pending_rows`/`pending_products` 参与签名，所以唯一漏判的情形是"第 200 行之后
> 恰好一个开启、另一个关闭、两个计数都不变" —— 这种下一分钟就会暴露，可以接受。

## 每次触发的判定流程

严格按顺序执行，每一步的"退出"都表示本次触发结束、不发任何消息。

1. **算 session**，载入状态文件；不存在就按上面的模板初始化。
2. `done` 为 true → 退出（本夜已收尾）。
3. 当前时间已过 `WINDOW_END` → 若 `phase == "tracking"` 且未完成，发**最终告警**
   （模板 D，理由写"到达窗口截止仍未全部开启"）；置 `done=true`，保存，退出。
4. 调 `check_daily_preopen(max_detail_rows=200)`。`checks += 1`。
   - 工具抛错 → 不发消息、不改签名，只 `stale_checks += 1` 后退出（只读操作，下一分钟
     自然重试）。**连续 5 次抛错**才发一条模板 E 提示。
5. **新鲜度门控**：`create_time` 为 null 或 `age_seconds > FRESH_MAX_AGE_SECONDS`
   → 写入进程没在产出：
   - `stale_checks += 1`。
   - 若 `phase == "warmup"`：当前时间过了 `WARMUP_DEADLINE` 且 `warmup_notified` 为
     false → 发模板 E，置 `warmup_notified=true`。保存，退出。
   - 若 `phase == "tracking"`：说明产出中途断了 → 发模板 E（写明"守护过程中写入进程
     停止产出"），置 `warmup_notified=true`。保存，退出。
6. 数据新鲜。`stale_checks = 0`，`phase = "tracking"`。
7. **核对排除名单**：`no_data_file` 里出现了不在 `EXPECTED_EXCLUDED` 里的产品名，
   且 `excluded_alerted` 为 false → 发模板 F，置 `excluded_alerted=true`。
   （这一步不能省：一个真产品的 portfolio 文件消失时，它会被静默排除出检查范围，
   于是"全部开启成功"里根本不包含它。）继续往下走。
8. `total_rows == 0` → 范围内没有任何可检查的产品 → 发模板 D（理由写 `warnings` 里
   那句），置 `done=true`，保存，退出。
9. 算 `signature`。若 `baseline_pending_rows` 为 null → 记基线
   （`baseline_pending_rows = pending_rows`、`baseline_at = create_time`）。
10. **完成判定**：`ready` 为 true →
    - 发**模板 B（完成）**。置 `done=true`，保存，退出。
    - 注意：即使这是本夜第一次检查（起跑晚了，扫描已经结束）也照样发，消息里注明
      没观测到基线。
11. **未完成**，比较签名：
    - `signature != last_signature` → **有变化**：发**模板 A（进度）**；
      `last_signature = signature`、`repeat_count = 1`、`alerted_signature = null`。
    - `signature == last_signature` → **无变化**：`repeat_count += 1`。
      - `repeat_count >= STALL_REPEATS` 且 `alerted_signature != signature`
        → 发**模板 C（停滞告警）**，置 `alerted_signature = signature`。
      - 否则不发消息。
    - 说明：`repeat_count` 从 1 起算（第一次看到这个集合算 1 次），所以"连续 3 次检查
      结果相同"在第 3 次触发告警。告警对同一个集合**只发一次**，避免每分钟重复刷屏；
      集合一变就恢复正常播报，再停滞会对新集合重新告警。
12. 保存状态，结束。

第 9 步先记基线、第 11 步才比签名，所以**本夜第一次检查不会发进度消息**——第一条
进度消息恰好对应"第一批产品开启"之后的那次变化，符合"从开始有产品开启后才输出"。
反过来，如果整夜一个产品都没开启，签名从不变化，第 3 次检查就会按第 11 步告警。

## 企业微信消息模板

`POST $WECOM_WEBHOOK_PREOPEN`，body `{"msgtype":"markdown","markdown":{"content":"…"}}`。

**正文上限 4096 字节**，务必按 `LIST_THRESHOLD` 截断：`pending_rows <= 30` 就逐条列，
否则只给汇总 + 按 `Index` 分组的前若干项，并注明"仅列部分"。工具侧
`pending_truncated` 为 true 时也要在消息里说明明细不全、计数才是完整的。

> **明细里不要带 `TraderAccount`。** 企业微信群的消息会长期留存、可被转发，账户号放
> 进去没有必要 —— `NAME` + `Colo` + `Index` + `Exchange` 已经足够定位到要处理的对象。
> 这与本部署不外发敏感运行配置的约束一致。确有需要
> 时再单独去查，不要默认外发。

### A. 进度

```markdown
**预开启进度** · 09-22 交易日
已开启 **1027** / 1107 行（505 / 571 产品）
未开启 **80** 行 / 66 产品
批次 23:40:12（3 秒前）
```

### B. 完成

```markdown
**预开启完成** ✅ · 09-22 交易日
571 个产品 / 1107 行全部开启成功
基线 23:40:12（80 行未开启）→ 完成 23:41:05，共 2 次检查
已排除 6 个无数据文件产品（LS，在预期名单内）
> ⚠️ HSDC1 上报卡住：Time 073000，落后约 16.5 小时，其 PnLratio=0 是陈旧值，不代表已就绪
```

`not_reporting_rows`、`missing_rows` 为 0 时对应的行就别写了。

### C. 停滞告警

```markdown
**预开启异常** ❗ · 09-22 交易日
连续 3 次检查（23:42 / 23:43 / 23:44）结果无任何变化，以下产品仍未开启：
> MIX3 · HJ1 · csc-sz-12 (SZ)
> MIX3 · HJ1 · csc-sh-12 (SH)
> HS300 · DC51B · cicc-sz-3 (SZ)
共 **12** 行 / 8 个产品 · 批次 23:44:05
**不要用快捷命令 start/stop 处理**（那是整机级的，会影响同一台 colo 上的其他产品）。
按 bssh-ops skill 的产品级操作或盘中改参流程走 preview → 确认 → execute。
```

### D. 最终告警（窗口截止 / 范围为空）

同 C 的形式，标题写 `**预开启未完成** ❗`，并写明原因（到达 `WINDOW_END` 仍未全部
开启，或范围内无可检查产品）。

### E. 写入进程未产出

```markdown
**预开启守护：拿不到数据** ⚠️ · 09-22 交易日
最新批次 2026-09-21 15:00:58（已过 30500 秒），写入进程没在产出监控数据。
如果今晚不是交易日前夜，可以忽略；否则请检查 stock_production_monitor 的写入链路。
本夜守护已停止。
```

### F. 排除名单异常

```markdown
**预开启守护：排除名单变了** ⚠️ · 09-22 交易日
以下产品因为没有 portfolio 文件被排除出检查范围，但不在预期名单里：
> LS · XXLS9 · cf-sh-2
它们不会被计入"全部开启成功"，请确认是否应该纳入检查。
```

## 约束

- **不得自动补救。** 本 skill 只观测和播报。发现未开启产品后要重启/改参，一律走
  `preview_change_cfg_paras` → `deploy_change_cfg_paras`（规则 9）或
  `preview_product_action` → `execute_product_action`（规则 2），保留人工确认。
  **尤其不要**因为"很多产品都没起来"就去用白名单快捷命令的 `start`/`stop` —— 它们
  不带产品参数、作用于整台 colo 上的全部产品（规则 5）。
- 消息里不放 webhook、API key、账户密码、账户配置。
- 一次触发最多发**一条**企业微信消息；上面的流程已经保证了这一点（每个分支都以
  发一条或不发结束）。

## 已知边界

- `PnLratio == 0` 也是"产品没在上报"的样子（写入侧 `.fillna(0)` + 名册 `how='right'`
  合并）。工具把无文件的行整行排除、把上报卡住的行放进 `not_reporting`，但按约定这两
  类都不影响 `ready`。所以"全部开启成功"严格的含义是**检查范围内**全部开启成功，
  播报时带上 `total_products` 而不要说"全部产品"。
- 真实收益小于约 0.05bp 会被四舍五入成 `0.0`，即一个已经在跑并有微小盈亏的产品可能
  被当成"已重置"。这个假阴性无法从这张表消除。
- 整行从批次里消失的产品，`pending` 判据看不见；`missing_rows` 会报出来，但它在扫描
  期间偶发（写入侧读到正在改写的文件），所以只附在消息里、不单独告警。
- 状态文件是单机的。多实例同时跑会各自发一份消息 —— harness 侧要保证同一 session
  只有一个执行者。
