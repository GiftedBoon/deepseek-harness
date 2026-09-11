# bssh-ops skill

[English](README.md) | 中文

本 bundle 为 Harness 提供 `bssh_ops` 远程运维 MCP 服务的经过评审的工作流。完整指令位于 `SKILL.md`；任务匹配后由 Harness Skill Loader 读取该文件。

## 应放在这里的内容

- bssh_ops 工具选择规则，以及产品操作必须遵循的“预览—确认—执行”流程。
- 单中心/双中心 colo 检查、自定义 shell 语法检查、失败处理和审计安全输出规则。
- 对实时工具结果的引用，不复制产品状态或凭据。

## 不应放在这里的内容

- MCP 服务实现、URL、API key 或其他凭据。
- 当前 colo 状态、产品映射、命令输出或审计记录。
- 通用产品定义；放在 `../../knowledge/business/`，通过 OpenViking 检索。
- 权限和风险策略定义；放在 `../../policies/`，并在工具执行路径上强制实施。

MCP patch 位于 [trader-ops-bssh-ops-mcp.patch.yml](../../config/dsh/trader-ops-bssh-ops-mcp.patch.yml)。只有部署环境提供 `TRADER_OPS_BSSH_MCP_ENABLED=1`、`TRADER_OPS_BSSH_MCP_URL` 和 `TRADER_OPS_BSSH_MCP_API_KEY` 后才会启用。
