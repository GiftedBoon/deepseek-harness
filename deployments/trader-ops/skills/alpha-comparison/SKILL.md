---
name: alpha-comparison
description: 对比实盘产品与 AlphaSim 的 Alpha 收益，按平台「Alpha 收益对比」页面同一口径返回指标明细表和趋势图，支持基准差值、指标切换与滚动窗口年化。
whenToUse: Use when a user asks about product or AlphaSim alpha returns, compares products or alphas, wants an alpha trend chart, a difference against a baseline, pos/trades/IPO/beta returns, or rolling annualized alpha.
user-invocable: true
---

# Alpha 收益对比

数据与平台「Alpha 收益对比」页面完全一致，全部只读。

## 工具

- `mcp__bssh-ops-remote__get_alpha_comparison`：取指标表和趋势图。**每次回答只调用一次**；参数校验报错时按提示修正后可再调一次。
- `mcp__bssh-ops-remote__list_alpha_targets`：用户给的名字不确定（大小写、简称、“HJ1 的模拟”）或对比结果出现 `failed` 时，先用 `keyword` 查确切名字，再调用对比工具。不要自己猜名字。
- `mcp__bssh-ops-remote__shift_trading_day`、`mcp__bssh-ops-remote__list_trading_days`：仅在用户按交易日说区间（“近 20 个交易日”）时用来换算日期。

## 参数映射

- 实盘产品代码放 `products`；AlphaSim 名放 `alphas`，包括实盘/历史 alpha、组合名和 `{产品}_alphasim`（“X 的模拟 / 联调”即 `X_alphasim`）。同一名字不要两边都放。用户没说对比谁时两者都不传，工具使用页面默认的产品列表。
- 日期：`今年以来` 不传 `date_from`；`某月` 传该月首日和末日；`最近 N 天/周/月` 按北京时间自然日换算；`近 N 个交易日` 先用交易日历工具换算。格式为 `YYYYMMDD`。不提结束日期时不传 `date_to`，默认为最新数据日。
- 指标 `metric`：alpha / 超额 / 默认 → `cumAlpha`；pos / 持仓 → `pos`；trades / 交易 → `trade`；打新 → `ipo`；beta / 指数 → `beta`；绝对收益 / alpha+beta → `alphaBeta`。
- 滚动：“滚动 / 滚动年化” → `view=rolling`，“N 日滚动” → `rolling_window_days=N`（默认 10）。只有 `cumAlpha`、`pos`、`trade` 支持滚动。
- 基准：“以 X 为基准 / 相对 X / 看和 X 的差值” → `baseline=X`，且 X 必须也在 `products` 或 `alphas` 里。
- 只要数字、不要图时传 `chart=false`。
- 追问（换基准、换指标、换日期、加减一个产品）时，沿用上一次调用的参数，只改变化的那一项。

## 固定输出

按以下顺序输出，不写工具调用过程，不复述参数：

1. `**{caption}**`
2. `table_markdown` **原样输出**，不改数字、不增删列、不调整行序。本 Skill 允许使用管道表格。若工具返回的是 `table_list`，原样输出列表。
3. 有 `table_note` 时紧接表格原样输出，写成一行引用 `> {table_note}`。
4. `highlights` 每条一行，最多 3 行；不要自己追加结论或投资建议。
5. `failed` 非空时用一行列出：`未取到：{name}（{reason}）`，多个用“；”分隔；`not_plotted` 非空时用一行写 `无该指标曲线：{名字}`；`warnings` 每条一行。
6. `chart_id` 不为 null 时末行写“趋势图随后单独发送。”

**禁止**在回复里写 `chart_id`、任何 URL、图片 markdown 或 HTML。图片由机器人在文字回复后自动发送。数值单位都是百分点；不要把括号里的数字改写成别的含义，它们的含义以 `table_note` 为准。整条回复不超过 8000 UTF-8 字节；超出时改用 `table_format=list` 重新查询，不要自行删行。

## 失败处理

工具报错时，用一行转述错误原因并停止。名字找不到时先按上文用 `list_alpha_targets` 查，查不到就告诉用户可选的相近名字。后端超时时建议缩短日期范围或减少对比数量；两分钟内的重复查询走缓存，可以稍后重试。不要改用 `db_run_query` 或其它工具去拼凑同样的数据。
