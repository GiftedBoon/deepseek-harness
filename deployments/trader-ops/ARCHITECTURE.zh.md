# Trader Ops 部署架构

[English](ARCHITECTURE.md) | 中文

这套骨架允许在业务知识和正式 skill（技能）都为空时先完成运行时接线。当前目标是验证组件边界、配置合成、持久化和远程启动方式，不是假装已经具备交易业务能力。

## 组件与数据流

```text
用户 / Web UI
      |
      v
DeepSeek Harness (web profile)
  |-- Main LLM -----------> 通过 llm-pi-ai 可选连接本地 Ollama
  |-- Skill Loader --------> deployments/trader-ops/skills/*/SKILL.md
  |                          完整加载；当前允许为 0 个
  |
  |-- Tool Policy ---------> tools/pre-execute + tools.guard()
  |                          首条匹配；未匹配调用默认拒绝
  |
  |-- OpenViking plugin ---> OpenViking HTTP service ---> 持久化目录
  |        |                       |
  |        | recall                +--> 后续接收 knowledge/*.md
  |        + session capture            当前允许为空
  |
  +-- future MCP client ----> Trader Ops MCP server ----> DB / API / NAS
           默认禁用
```

`knowledge/` 是待提交给 OpenViking 的受版本控制真源。OpenViking 插件负责会话记忆、检索和相关 MCP 工具的桥接，但不会自动扫描这个 Git 目录；后续应通过评审后的入库流水线、OpenViking Studio 或 `mcp__openviking__add_resource` 显式提交内容。

`skills/` 由额外的 `@deepseek-ai/dsh-skill-filesystem` 提供方发现。目录中的 `README.md` 只是说明文档，只有 `<skill-name>/SKILL.md` 才会进入 catalog，并在匹配任务时由 Harness Skill Loader 完整加载。

`policies/tool-access.yaml` 由 `@deepseek-ai/dsh-experimental-quant-tool-policy` 加载。它通过 `tools/pre-execute` 执行环境/工具规则，并用 `ctx.tools.guard()` 重复失败关闭边界。在可信身份和审批存储存在之前，`risk-levels.yaml` 与 `approvals.yaml` 仍是设计约定。

## 已接通与未接通

| 能力 | 当前状态 | 说明 |
|---|---|---|
| OpenViking 服务 | 可部署 | Docker Compose、持久化目录和健康检查已定义 |
| OpenViking DSH 插件 | 可安装 | 固定使用 `@openviking/dsh-memory-plugin@0.3.0` |
| Harness 本地模型 | 可选、已验证 | `llm-pi-ai` 把 `qwen3.5:4b` 路由到宿主机 Ollama，不需要外部 key |
| Trader Ops skill 根目录 | 已配置 | 空目录是合法状态，未来添加 `SKILL.md` 即可发现 |
| Git 知识自动入库 | 未实现 | 必须单独实现评审、提交、更新和删除语义 |
| Trader Ops MCP | 模板、默认关闭 | 真实服务存在后再启用示例 patch |
| Harness 工具策略 | 实验性、已强制执行 | 首条匹配 allow/ask/deny、默认拒绝，并带防绕过 guard |
| 身份、资源授权、审计 | 未实现 | 必须由 Trader Ops MCP 服务和审批存储强制执行 |

## 安全边界

- OpenViking 默认只绑定 `127.0.0.1:1933`。跨主机访问应经过私网或带 TLS 的反向代理，不应直接暴露端口。
- 本地 Ollama 绑定 `127.0.0.1:11434`；Docker Desktop 通过 `host.docker.internal` 访问它，Harness 则使用宿主机回环地址上的 OpenAI-compatible 端点。
- DSH 默认从 `DSH_PERMISSION_MODE=read-only` 开始。该值约束 Harness 本地沙箱，不等价于业务 tool guard。
- OpenViking 凭据只通过环境变量注入。`OPENVIKING_ROOT_API_KEY` 用于账户管理并与 `server.root_api_key` 一致；Harness 使用权限更窄的租户级 `OPENVIKING_API_KEY` 访问数据。
- `mcp__openviking__forget` 是永久删除操作，当前策略已显式拒绝它。OpenViking 仍必须独立认证并授权绕过 Harness 的直接客户端。
- 所有动态业务状态应实时从 MCP/API 查询，不能以检索到的旧 Markdown 代替。

## 配置分层

```text
DSH 内置 web profile
  + profile 中安装的 OpenViking bundle patch
  + config/dsh/trader-ops.patch.yml
  + （本地可选）config/dsh/trader-ops-local-ollama.patch.yml
  + （未来可选）config/dsh/trader-ops-mcp.patch.yml
```

后加载的 patch 会覆盖同一配置项的完整 `config`，不是深度合并。因此修改 `openviking-memory-runtime` 时必须保留本文件中仍需生效的全部字段，并用 `--dump-config` 检查最终配置。
