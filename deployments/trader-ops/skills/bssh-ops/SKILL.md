---
name: bssh-ops
description: Operate the bssh_ops quantitative-trading remote operations MCP server with product-aware previews, explicit production confirmation, change-cfg-paras deployment, and audit-safe execution.
---

# bssh_ops 远程运维

该 Skill 配合 `mcp__bssh-ops-remote__*` 工具使用。MCP 服务通过 HTTP 访问 bssh_ops 后端；连接地址和 `X-API-Key` 由部署环境注入，绝不要在回复、日志、Skill 或代码仓库中展示或保存密钥。

## 工具选择

只读工具可以直接调用：

- `list_live_colos`：列出当前在线 colo 及单中心/双中心分组。
- `list_quick_commands`：查看机器级快捷命令清单。
- `list_runs`、`get_run_status`：查询执行记录和状态。
- `list_product_actions`：列出产品级动作定义。
- `preview_product_action`：解析产品归属、渲染命令并做语法检查，不连接远端执行。
- `list_colos_for_index`：按 Index 或产品分类批量解析产品及其全部 colo，不连接远端执行。
- `list_change_cfg_paras_runs`：查询改参 preview/deploy 审计记录。
- `check_shell_syntax`：对自定义 shell 命令做语法检查。

`preview_change_cfg_paras` 不连接远端，但会覆盖同一交易日已生成、尚未部署的本地改参 cfg；不能把它当作可随意重复的纯只读预览。

会在真实 colo 上产生副作用的工具是 `run_quick_command`、`run_scp`、`execute_product_action`、`deploy_change_cfg_paras` 和 `exec_change_cfg_paras`。它们的 stdout/stderr 会按 `run_id` 写入 bssh_ops 审计记录；不要执行会打印密码、令牌或其他敏感信息的命令，也不要自行传 `operator`，服务端会固定记录为 `ai-agent`。

## 未来时刻执行

用户要求在未来时刻执行快捷命令时，先调用 `list_quick_commands` 获取当前清单，再调用 `scheduled_action_create`：`action` 使用 `quick_command`，`target` 和 `at` 原样使用用户给出的目标与时间，`input` 使用清单返回的准确 key。不得猜测、改写或使用未返回的 key；清单在到点前变更时，bssh_ops 会在执行时拒绝失效的 key。`ps_check` 是兼容入口；普通流程仍使用 `quick_command` 和 `input: check`。

用户要求在未来时刻执行自定义 shell 时，先调用 `check_shell_syntax`，向用户展示准确目标、完整命令、预期影响和回滚方式并取得明确确认，再调用 `scheduled_action_create`：`action` 使用 `custom_shell`，`target` 和 `at` 使用已确认的目标与时间，`input` 使用已确认且通过语法检查的原始命令。不得在定时记录中放入密码、令牌或其他敏感值。

未来执行请求不得立即调用 bssh_ops 写工具，不得用 bash 查询时间或等待，也不得改用只发送会话消息的 `schedule_create`。只有 `scheduled_action_create` 返回成功后，才能说明动作已经安排；如果所需动作不在枚举中，应说明该动作没有列入本部署的可定时动作清单——这是部署配置的选择，不代表该工具或 bssh_ops 缺少定时执行能力——并列出当前枚举中可用的动作。

## 产品级操作流程

产品分为单中心和双中心。单中心产品的 Colo-SZ 与 Colo-SH 是同一台物理机器，预览去重后应返回 1 台 colo；双中心产品分别运行在两台机器上，应返回 2 台。不要自行查询或判断 `Dual` 字段；以本次 `preview_product_action` 的归属解析结果为准。

产品级动作必须严格执行以下流程，不得因为用户措辞肯定而跳过确认：

1. 解析并复述产品名；缺少产品名时提问，不能猜测。
2. 调用 `preview_product_action`。
3. 把返回的完整 `colos`、`shell_command`、动作说明和风险展示给用户。`colos` 数量是合理性检查：1 台表示单中心，2 台表示双中心；与用户预期不一致时停止并核实产品归属。
4. 取得明确确认后，原样把 preview 返回的 `confirmed_colos` 与 `confirmed_shell` 传给 `execute_product_action`。
5. 返回 `run_id`、每台 colo 的结果和失败信息；不要声称未返回的操作成功。

不要把 `stop_signal`、`start_signal`、`stop_trader` 或 `start_trader` 当作产品级动作。这些命令影响整台机器，可能连带其他产品。产品操作只能使用经过评审、明确只影响该产品的 `product_ops_actions.json` 动作。

## Index 与分类批量操作

按 Index 或产品分类批量选择机器时，先调用 `list_colos_for_index`，再向用户完整展示返回的 `products`、`colos` 及其数量。若产品或 colo 为空，说明未匹配到目标并停止，不能自行补充机器。

将解析结果的数量级与用户预期核对；出现明显差异时停止并核实 Index、分类及当天产品归属。即使后续只执行 `ps check` 等只读快捷命令，也必须先取得用户对完整范围的明确确认，再把确认后的 `colos` 原样传给 `run_quick_command`。

## 盘中改参与策略启停

当用户要求对指定产品执行 `kill`、`start`、`open_t0`、`close_t0` 或其他 `preview_change_cfg_paras` 白名单内的改参命令时，优先使用 change-cfg-paras 官方通道，不要改用 `execute_product_action` 或现场拼 shell。工具自身的参数说明是 rule 结构和 `cmd` 白名单的权威来源。

同一交易日多次 preview 是覆盖而非追加：收集当天要一起生效的全部规则，合并成一个 `rules` 数组，只调用一次 `preview_change_cfg_paras`。`curdate` 缺省为今天，不得填写过去的交易日。

严格执行以下流程：

1. 确认产品、命令、参数和交易日；信息不全时提问，不能猜测。
2. 用包含全部规则的单次 `preview_change_cfg_paras` 生成预览。
3. 向用户完整展示返回的 `affected`，包括交易所、参数、产品清单与数量，并说明再次 preview 会覆盖当天尚未部署的 cfg。
4. 取得明确确认后，调用 `deploy_change_cfg_paras`；`expected_time_flag` 必须原样使用该次 preview 返回的 `cfg_time_flag`。若服务端返回 409，重新 preview 并再次取得确认，不能自行绕过。
5. deploy 成功后记录返回的 `exec_run_id`，用 `get_run_status` 查询执行结果。只有部分 colo 失败时，才可考虑用 `exec_change_cfg_paras` 重试，无需重新 preview/deploy。

调用 `exec_change_cfg_paras` 前，先用 `list_change_cfg_paras_runs` 或 `get_run_status` 核实要重试的 deploy 和准确 colo 列表，把目标与影响展示给用户并取得明确确认。该工具会重新执行已经下发的真实改参内容，不是查询或预览。

## 自定义命令与安全边界

- 自己拼接 `custom_shell` 时，先调用 `check_shell_syntax`，再请求用户确认，最后才立即执行或创建定时动作。
- `run_quick_command` 的自定义命令必须说明目标 colo、命令全文、预期影响和回滚方式。
- 任何涉及生产策略进程、配置、文件覆盖或复制的写操作都需要用户明确确认；没有收到确认时停止，不调用写工具。
- 不要把实时状态、产品归属或动作定义写入知识库；它们必须来自本次 MCP 查询。
- 对单中心产品只接受一台 colo，对双中心产品接受两台 colo；预览返回数量异常时先与人核实。
- `product_ops_actions.json` 中的动作每次调用都会重新读取，无需重启 MCP 服务。新增或选择动作时，确认它确实只影响单个产品，且 `label` 与 `shell_template` 的实际效果一致；`{product}` 只负责模板替换，不证明命令已按产品隔离。

## 失败与审计

连接失败、工具错误、语法检查失败或用户确认未完成时，保留失败事实并停止后续写操作。执行结果通过 `run_id` 在 bssh_ops 的 `BsshOpsRun` 审计表中长期可查；向用户报告时只包含完成任务所需的最小输出，不把审计记录中可能出现的敏感值复制进回复。
