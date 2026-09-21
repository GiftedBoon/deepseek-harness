---
name: bssh-ops
description: Use the bssh_ops MCP server for audited quantitative-trading colo operations, including persistent quick-command plans, product-scoped preview and execution, file transfer, process checks, and change-cfg-paras deployment. Apply when a request targets live colo machines or product strategy state; use database-query for read-only business database analysis.
---

# bssh_ops 远程运维

该 Skill 配合 `mcp__bssh-ops-remote__*` 工具使用。连接地址和 `X-API-Key` 由部署环境注入；绝不要在回复、日志、Skill 或代码仓库中展示或保存密钥。实时状态、产品归属和动作定义必须来自本次 MCP 查询，不能写入知识库后复用。

## 工具选择

以下工具不改变远端 colo 状态，可以直接调用：

- `mcp__bssh-ops-remote__list_live_colos`、`mcp__bssh-ops-remote__list_quick_commands`、`mcp__bssh-ops-remote__list_runs`、`mcp__bssh-ops-remote__get_run_status`。
- `mcp__bssh-ops-remote__get_operation_plan`：查询本地快捷命令计划。
- `mcp__bssh-ops-remote__list_product_actions`、`mcp__bssh-ops-remote__preview_product_action`：查询产品级动作，解析产品归属，渲染命令并检查语法。
- `mcp__bssh-ops-remote__list_colos_for_index`：按 Index 或产品分类解析全部产品和 colo。
- `mcp__bssh-ops-remote__list_change_cfg_paras_runs`、`mcp__bssh-ops-remote__preview_change_cfg_paras`：查询改参审计记录或纯解析规则；preview 不连接远端、不生成或覆盖 cfg、不落审计。
- `mcp__bssh-ops-remote__check_shell_syntax`：静态检查动作模板中的 shell 语法，不执行命令。

`mcp__bssh-ops-remote__prepare_quick_command` 只把快捷命令、目标和执行窗口写入 MCP 本地 SQLite，不连接远端。`mcp__bssh-ops-remote__check_process_status` 只执行固定的 `ps check`；它会连接远端并生成 `run_id`，但不改变远端状态。

以下工具会在真实生产 colo 上执行操作：`mcp__bssh-ops-remote__execute_quick_command_plan`、`mcp__bssh-ops-remote__run_scp`、`mcp__bssh-ops-remote__execute_product_action`、`mcp__bssh-ops-remote__deploy_change_cfg_paras` 和 `mcp__bssh-ops-remote__exec_change_cfg_paras`。其 stdout/stderr 会按 `run_id` 长期写入 bssh_ops 审计记录；不要执行会输出密码、令牌或其他敏感信息的操作，也不要传 `operator`，服务端会按调用凭据记录为 `ai-agent`。

## 快捷命令

先调用 `list_quick_commands` 取得当前白名单 key，再调用 `prepare_quick_command`；只把返回的 `plan_id` 传给 `execute_quick_command_plan`。计划冻结完整 `colos`、`shell` 和执行窗口并防止重复派发，不是审批单；用户已经明确要求执行时可以连续完成 prepare 和 execute，无需追加确认。需要稍后执行时保存 `plan_id`，不能只保存 command key。

`execute_quick_command_plan` 会在派发前锁定计划，并重新核对快捷命令定义；同名 key 的实际命令发生变化时拒绝执行。后端调用结果不确定时，计划进入 `uncertain`，不得自动重试。固定进程检查直接使用 `check_process_status`。

未来执行快捷命令时，先按用户指定的目标和时间调用 `prepare_quick_command`，再用 `scheduled_action_create` 创建 `quick_command_plan` 动作：`target` 原样使用返回的 `plan_id`，`at` 使用用户指定的时间。未来固定进程检查使用 `ps_check` 动作和准确 colo。只有 `scheduled_action_create` 成功后才能说明已安排执行；不得为未来执行保存裸 command key 或 shell。

不得提交任意 shell。自定义命令只能来自 `product_ops_actions.json` 中预先定义的动作模板，并走 `preview_product_action` → `execute_product_action`。白名单快捷命令和产品级动作都覆盖不到时，停止并说明缺少已评审的动作定义。

## 产品级操作

单中心产品的 Colo-SZ 与 Colo-SH 是同一台物理机器，预览去重后返回 1 台 colo；双中心产品分别运行在两台机器上，返回 2 台。不要自行查询或判断 `Dual` 字段，以本次 `preview_product_action` 的归属解析结果为准。若返回数量与用户预期不一致，停止并核实产品名和当天归属。

产品级动作必须执行以下流程，即使用户原话已经明确要求执行也不能跳过确认：

1. 确认产品名；缺失时提问，不能猜测。
2. 调用 `preview_product_action`；`syntax_ok` 为 false 时停止。
3. 向用户展示完整 `colos`、`shell_command`、动作说明、风险以及 1 台或 2 台 colo 的含义。
4. 取得明确确认后，把 preview 返回的 `confirmed_colos` 和 `confirmed_shell` 原样传给 `execute_product_action`。
5. 返回 `run_id`、每台 colo 的结果和失败信息，不声称未返回的操作成功。

`stop_signal`、`start_signal`、`stop_trader` 和 `start_trader` 影响整台机器，可能连带同机其他产品，不能当作产品级动作。`product_ops_actions.json` 中的动作每次调用都会重新读取；动作必须确实只影响单个产品，且 `label` 与 `shell_template` 的实际效果一致。`{product}` 只负责模板替换，不证明命令已按产品隔离。

## Index 与分类批量操作

先调用 `list_colos_for_index`，再向用户完整展示返回的 `products`、`colos` 及数量。产品或 colo 为空时，说明未匹配到目标并停止；数量级与预期明显不符时，先核实 Index、分类和当天产品归属。

取得用户对完整范围的明确确认后，固定进程检查使用 `check_process_status`；其他快捷命令把完整 `colos` 传给 `prepare_quick_command`，再用返回的 `plan_id` 执行。

## 盘中改参与策略启停

对指定产品执行 `kill`、`start`、`open_t0`、`close_t0` 或其他 `preview_change_cfg_paras` 白名单命令时，优先使用 change-cfg-paras 通道，不使用 `execute_product_action` 或临时 shell。工具参数说明是 rule 结构和 `cmd` 白名单的权威来源；`product_ops_actions.json` 只用于白名单覆盖不到的产品级动作。

`preview_change_cfg_paras` 只解析规则，`deploy_change_cfg_paras` 才会生成当天 cfg、上传跳板机并触发 colo 生效。cfg 是覆盖写入；当天需要一起生效的全部规则必须合并到同一次 `rules` 数组和一次 deploy 中。`curdate` 缺省为今天，不能填写过去的交易日。

严格执行以下流程：

1. 确认产品、命令、参数和交易日；信息不全时提问，不能猜测。
2. 用包含当天全部规则的单次 `preview_change_cfg_paras` 生成预览。
3. 向用户完整展示返回的 `affected`，包括交易所、参数、产品清单与数量。
4. 取得明确确认后调用 `deploy_change_cfg_paras`；`rules` 必须与该次 preview 逐字一致，`confirmed_plan_digest` 原样使用 preview 返回的 `plan_digest`。
5. 摘要不一致时重新 preview 并再次确认，不能绕过。deploy 成功后，用返回的 `exec_run_id` 调用 `get_run_status` 查询结果。

只有部分 colo 失败时，才考虑用 `exec_change_cfg_paras` 重试，无需重新 preview 或 deploy。重试前先用 `list_change_cfg_paras_runs` 或 `get_run_status` 核实具体 deploy 和准确 colo 列表，向用户展示目标与影响并取得明确确认；不得自动扩大范围。人在 `/ops/bssh` 改参页面生成的 cfg 不属于 Agent 链路，不能代为下发。

## 失败与审计

连接失败、工具错误、语法检查失败、计划进入 `uncertain` 或用户确认未完成时，保留失败事实并停止后续写操作。报告只包含完成任务所需的最小输出，不把审计记录中可能出现的敏感值复制进回复。
