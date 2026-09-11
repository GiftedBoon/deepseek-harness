---
name: bssh-ops
description: Operate the bssh_ops quantitative-trading remote operations MCP server with preview, confirmation, and audit-safe execution.
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
- `check_shell_syntax`：对自定义 shell 命令做语法检查。

会在真实 colo 上产生副作用的工具是 `run_quick_command`、`run_scp` 和 `execute_product_action`。它们的 stdout/stderr 会按 `run_id` 写入 bssh_ops 审计记录；不要执行会打印密码、令牌或其他敏感信息的命令，也不要自行传 `operator`，服务端会固定记录为 `ai-agent`。

## 产品级操作流程

产品级动作必须严格执行以下流程，不得因为用户措辞肯定而跳过确认：

1. 解析并复述产品名；缺少产品名时提问，不能猜测。
2. 调用 `preview_product_action`。
3. 把返回的完整 `colos`、`shell_command`、动作说明和风险展示给用户。`colos` 数量是合理性检查：1 台表示单中心，2 台表示双中心；与用户预期不一致时停止并核实产品归属。
4. 取得明确确认后，原样把 preview 返回的 `confirmed_colos` 与 `confirmed_shell` 传给 `execute_product_action`。
5. 返回 `run_id`、每台 colo 的结果和失败信息；不要声称未返回的操作成功。

不要把 `stop_signal`、`start_signal`、`stop_trader` 或 `start_trader` 当作产品级动作。这些命令影响整台机器，可能连带其他产品。产品操作只能使用经过评审、明确只影响该产品的 `product_ops_actions.json` 动作。

## 自定义命令与安全边界

- 自己拼接 `custom_shell` 时，先调用 `check_shell_syntax`，再请求用户确认，最后才调用写操作工具。
- `run_quick_command` 的自定义命令必须说明目标 colo、命令全文、预期影响和回滚方式。
- 任何涉及生产策略进程、配置、文件覆盖或复制的写操作都需要用户明确确认；没有收到确认时停止，不调用写工具。
- 不要把实时状态、产品归属或动作定义写入知识库；它们必须来自本次 MCP 查询。
- 对单中心产品只接受一台 colo，对双中心产品接受两台 colo；预览返回数量异常时先与人核实。

## 失败与审计

连接失败、工具错误、语法检查失败或用户确认未完成时，保留失败事实并停止后续写操作。执行结果通过 `run_id` 在 bssh_ops 的 `BsshOpsRun` 审计表中长期可查；向用户报告时只包含完成任务所需的最小输出。
