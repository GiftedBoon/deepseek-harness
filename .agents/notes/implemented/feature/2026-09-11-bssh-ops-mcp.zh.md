# Agent Note：bssh_ops 远程运维 MCP 接入

状态：已实现

[English](2026-09-11-bssh-ops-mcp.md) | 中文

## 问题

Trader Ops 部署需要受控连接到现有 bssh_ops HTTP MCP 服务，以检查 colo 并执行经过评审的产品操作。连接不能把 API key 放入 patch 或源文件，模型可见工具也需要稳定名称和明确的执行策略。

## 决策

新增可选的 `@deepseek-ai/dsh-mcp-client` 层 `config/dsh/trader-ops-bssh-ops-mcp.patch.yml`。它使用 `bssh-ops-remote` 命名空间、Streamable HTTP 和从 root 所有部署环境读取的 `X-API-Key`。每个 Trader Ops profile 命令都会加载该 patch，但只有环境启用后才会激活。

新增 `configure-bssh-ops-mcp.sh`，通过隐藏提示读取 key，更新权限为 0600 的环境文件，重建 profile，验证策略和 Skill 层，安装当前 systemd unit，并在检查成功后重启。策略允许只读的 Harness `skill` 加载器和 bssh_ops 检查工具；远程执行工具要求审批，并且仍受下游授权约束。

`bssh-ops` Skill 固化产品操作必须遵循的“预览—确认—执行”流程、单中心/双中心合理性检查、自定义 shell 语法检查、机器级命令限制和 `run_id` 审计处理。Skill 不包含端点凭据或实时业务状态。

## 备选方案

**把 API key 放入 MCP patch。** 否决，因为 patch 受源代码管理，可能被复制到日志或发布包；key 应保存在 root 所有的环境文件中。

**不经预览直接暴露写工具。** 否决，因为产品动作可能影响一台或两台物理 colo 主机及生产进程；Skill 和策略必须在执行前完成评审。

**使用 `trader_ops` 这样的通用服务名。** 否决，因为稳定的 `bssh-ops-remote` 命名空间能标识该外部服务，并避免与其他 Trader Ops MCP 服务冲突。

## 安全与生命周期

bssh_ops 端点是私网中的明文 HTTP，不得暴露到公网。API key 保存在权限为 0600 的 `/etc/deepseek-harness/trader-ops.env` 中；配置器隐藏提示，避免写入 shell history。Harness 策略不能替代 bssh_ops 自身的主体、资源和参数级授权。

## 验证

Skill 通过 Skill Creator 校验器。Profile 渲染确认 MCP 层会插入且默认关闭。静态检查确认策略允许 `skill` 加载器，并确认配置器会先安装包含 bssh_ops patch 的 unit 再重新加载 systemd。配置器通过 shell 语法检查，发布前还必须通过仓库文档门禁。

## 影响

启用后，bssh_ops 工具描述和用户请求会对配置的中转模型可见。工具使用稳定的 `mcp__bssh-ops-remote__` 前缀。停用会保留已保存的 key，便于轮换或重新启用；上游凭据变化时运维人员必须主动轮换。
