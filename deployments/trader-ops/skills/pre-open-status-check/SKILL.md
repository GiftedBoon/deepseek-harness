---
name: pre-open-status-check
description: 查询实盘产品预开启状态，核验交易日与判断窗口，并按企业微信 Markdown 固定格式报告待开启、缺失和排除记录。
whenToUse: Use when a user asks for the current daily pre-open status, completion, or pending products.
user-invocable: true
---

# 预开启状态检查

每次请求都调用 `mcp__bssh-ops-remote__check_daily_preopen`，传 `max_detail_rows=30`。它只读最新一批 `trade.ProductionMonitorData`，不连接 colo；`ready` 只表示检查范围内每行 `PnLratio` 为 0。`pending` 是此判据的异常行。行数与产品数不同，计数以工具汇总字段为准，明细可能截断。不要用 `TimeIsRight` 或 `All` 列替代工具判据，也不要仅凭 `ready` 判断当夜完成。

## 判断时间

使用北京时间 `Asia/Shanghai`。有效判断窗口只属于**目标交易日的前一自然日 23:30:00 至目标日 01:00:00**，含两端：当前时刻为 23:30:00～23:59:59 时，候选目标日是明天；为 00:00:00～01:00:00 时，候选目标日是今天；其他时间不属于窗口。不要把“下一个交易日”的前一交易日晚上直接当作前夜，节假日会使两者相隔多天。

仅在上述时钟窗口内调用 `mcp__bssh-ops-remote__get_trading_calendar`，`at` 传候选目标日的 `YYYY-MM-DDT12:00:00+08:00`。返回的 `date` 必须等于候选目标日。`estimated=false` 且 `is_trading_day=true` 才是有效判断窗口；`estimated=false` 且 `is_trading_day=false` 为 `非预开启判断时段`。日历失败、字段缺失、日期不符或 `estimated=true` 时为 `交易日未核验`，不使用估算日历给出完成结论，并说明原因。不要按星期推断交易日，也不要单独用日历的 `is_preopen_night`：它不覆盖午夜后的半个窗口。

时钟窗口外仍正常调用预开启工具，但结论为 `非预开启判断时段`，数据只作实时快照。日历查询不影响预开启工具的调用。

## 数据判定与优先级

1. 工具报错、必要汇总字段缺失、计数为负、`pending_rows > total_rows`、`pending_products > total_products`，或 `ready` 与 `pending_rows = 0` 且 `total_rows > 0` 的关系不符：`检查失败`。
2. `create_time` 为空、`is_today=false`、`age_seconds` 为空或大于 180：`数据过期`。最新批次可能是残留状态，不能据此报告完成。
3. `total_rows = 0`：`无法判断`，检查范围为空。
4. 其余情况先看时间：时钟窗口外或确认为休市日是 `非预开启判断时段`；日历未核验是 `交易日未核验`。这两种结论仍展示数据快照。
5. 有效窗口内，`pending_rows > 0` 为 `未完成`；`pending_rows = 0` 但 `missing_rows > 0` 或 `previous_batch_compared=false` 为 `无法确认完成`；其余为 `已完成 ✅`。

第 1～3 项的结论优先于时间结论，并附一行时间说明。`missing_rows` 是上一批有、本批整行消失的记录；`previous_batch_compared=false` 表示没有完成比对，不能写“没有产品消失”。`no_data_file` 已整体排除在 `total_rows`、`total_products` 和 `pending` 外，不算异常。`not_reporting_rows` 有文件但上报卡住，也不计入 `pending`；若非零，必须提示其零值可能陈旧，`已完成` 仅表示工具判据通过。不要把这些情况自动转成重启或改参。

## 固定输出

只使用企业微信 `markdown` 可显示的加粗、引用和换行，不用管道表格、代码围栏或 HTML。按以下顺序输出，不加工具调用过程、字段清单或重复结论。仅第 5 项的 `已完成 ✅` 带 ✅。

```markdown
**结论：{结论}**
目标交易日：{目标日期；时钟窗口外写“—”}
批次：{create_time}（延迟 {age_seconds} 秒）
范围：{total_rows} 行 / {total_products} 产品｜待开启：{pending_rows} 行 / {pending_products} 产品
```

非有效窗口紧接摘要用一行说明“当前不在预开启判断窗口，以上仅为实时快照”或“交易日未核验，以上仅为实时快照”；估算日历要明确写“交易日历为估算，未核验节假日”。数据失败、过期、范围为空或未能比对上一批时，用一行写明原因。`missing_rows > 0` 时单独列出：

```markdown
**缺失记录（{missing_rows} 行）**
> {missing.NAME} · {missing.Index} · {missing.Colo} · {missing.Exchange}
```

`no_data_file_products > 0` 时，再单独列出被排除的产品：

```markdown
**无数据文件排除（{no_data_file_products} 产品）**
> {no_data_file.NAME} · {no_data_file.Index} · {no_data_file.Colo}
```

两组各最多展示 20 行，按工具返回顺序排列；用 `missing_rows`、`no_data_file_rows` 作完整行数。计数大于展示行数或对应的 `*_truncated=true` 时，在组后写“仅展示前 {展示行数}/{完整行数} 行”。有计数但明细未返回时写“明细未返回”，不生成空组。缺字段写 `—`，将字段中的换行压成空格，绝不展示 `TraderAccount`。`not_reporting_rows > 0` 时在末尾用一行提示上报卡住的行数；其他实质性 `warnings` 只用一行概括。默认不重复报告 `pending_truncated`；用户明确要求待开启名单时才追加同样限长的 `pending` 分组并说明截断。

整条回复不超过 4096 UTF-8 字节。超限时只减少明细行数，在完整行边界写明截断；未知汇总值写 `—`。`已完成 ✅` 只表示本次检查范围内、当前批次的 `PnLratio` 判据通过。
