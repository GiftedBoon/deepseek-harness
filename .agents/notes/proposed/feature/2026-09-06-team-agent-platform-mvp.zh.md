# Agent Note: 受控团队级 Agent 平台 MVP

Status: proposed

[English](2026-09-06-team-agent-platform-mvp.md) | 中文

## 问题

量化投资机构内部的 Agent（智能体）需要把经过评审的业务知识与实时数据库、NAS、日志、监控和自动化能力组合起来。模型不能成为凭据、数据范围、生产审批或危险变更的授权方。仓库已经具备 MCP、Skill（技能）、限定 scope 的 tools（工具）、审批、沙箱、Session 审计、presets 和 worker-thread workflow 能力；另建 Agent 框架会重复现有扩展点，并产生不兼容的策略路径。

## 提议

第一版部署由私有 experimental 包与外部 Git 管理的知识 workspace 组成。复用当前能力包，不修改 `packages/core/agent-loop`。

### 仓库拓扑

实现沿用现有 package 与 bundle 约定：

| 路径 | 职责 |
|---|---|
| `packages/experimental/quant-ops-mcp-server/` | 私有 MCP server，公开五个有界业务与运维 tool，并强制执行身份、资源范围、输入限制、幂等和权威审计写入 |
| `packages/experimental/quant-tool-policy/` | 基于 `tools/pre-execute` 与 `ctx.tools.guard()` 的 Cordis 策略插件，用于划分 tool 等级、单调拒绝禁用 tool，并按配置请求单操作审批 |
| `packages/experimental/quant-agent-profile/` | 私有可安装 bundle，组合策略插件、`dsh-mcp-client`、权限默认值、skill 发现、Session 持久化与固定版本的 OpenViking bundle |
| `packages/experimental/README.md` 与 `packages/experimental/README.zh.md` | 实现上述三个私有包时增加对应分组映射 |
| 部署知识仓库 `.agents/skills/<name>/SKILL.md` | 由现有 `dsh-skill-filesystem` 提供方发现、经过 Git 评审的业务 SOP |
| 部署知识仓库 `business/`、`ops/`、`architecture/` 与 `decisions/` | 人工维护的 Markdown 真源，携带源路径与 commit 元数据摄取到 OpenViking |

每个 experimental 包遵循 `packages/experimental/AGENTS.md`：使用 `@deepseek-ai/dsh-experimental-*` 前缀、保持私有，并接受与发布包相同的 README、测试、生命周期和安全覆盖。Profile 沿用现有 `packages/experimental/agent-team-profile/` bundle 模式。MCP server 保持进程外权威，通过现有 `packages/mcp/mcp-client/` 连接；业务 tool 不直接注册到 `ctx.tools`。

### 首批 MCP tools

Server 在一个配置的 namespace 下只公开五个 v1 tool：

- `product_lookup`：从获准的产品、策略、账户与部署视图中查询具名字段。
- `db_query_readonly`：默认使用具名模板；只有通过 parser 验证、只读数据库凭据、schema 允许清单、行数、字节和截止时间限制后才接受可选 SQL。
- `nas_search`：只访问允许清单根目录，执行规范路径包含检查、文件类型与大小限制、有界摘录，且不提供写操作。
- `log_query`：只访问允许清单内的服务与主机，限制时间范围与结果大小，并对调用方隐藏后端专用凭据。
- `run_approved_script`：只接受允许清单 operation id，逐 operation 定义 schema，并要求 dry-run、幂等键、目标与环境限制、先审计后执行、服务端签发的 correlation id 及后置条件证据。Harness 按配置在分发前询问。第一版不注册 L3 operation。

MCP server 从 transport 或 workload identity 推导经过认证的操作者。它绝不信任只由模型参数提供的操作者、角色、审批结果、目标等级或环境。每个响应返回 correlation id 与结构化证据；secret 与不受限命令字符串既不是输入，也不是输出。

### 首批 skills

部署知识仓库首批包含八个 skill：`answer-business-question`、`lookup-product-state`、`investigate-strategy-state`、`inspect-production-logs`、`diagnose-job-failure`、`rerun-data-pipeline`、`restart-approved-service` 与 `prepare-strategy-switch`。前五个只读。之后两个可在前置条件与审批规则通过后请求 L2 tool。`prepare-strategy-switch` 在第一版只生成计划，不能调用生产变更。

每个 skill 说明前置条件、证据来源、tool 顺序、停止条件、审批等级、验证和升级路径。它通过稳定路径引用 Vault 文档，并使用 tool 请求当前事实，不嵌入会变化的产品或主机清单。

### OpenViking 集成

在部署 profile 中安装固定版本的 `@openviking/dsh-memory-plugin`，而不是在本仓库再创建一个 memory 抽象。只为符合条件的主 Session 配置自动召回与捕获；在脱敏得到证明前保持 `captureToolResults` 关闭；Vault 派生资源保留源仓库、路径、commit、所有者、分类与摄取时间。

兼容性门禁使用实际部署的精确 DSH 与 OpenViking 插件版本。它验证恢复会话只注入一次 profile、主 Session 与 subagent 隔离、失败写入重放、删除与留存行为、`viking://` URI 保护、凭据优先级，以及 OpenViking 不可用时的启动行为。Memory 服务失败或不可用可以降低召回能力，但绝不能扩大 tool 权限或解锁操作。

### 策略、审批与审计

Profile 只公开 Agent preset 所需的 tool。`quant-tool-policy` 把每个可见 tool 分类为 L1、L2 或 L3：L1 通过范围检查后允许，L2 生产操作按配置询问，L3 在第一版被单调拒绝。MCP server 重复授权检查，绝不把 Harness 决策视为充分权限。

`dsh-user-approval` 提供人工决定与 Session `approval/asked`/`approval/decided` 记录。MCP server 在执行前后另行写入权威的仅追加效果记录。它签发 correlation id，把 id 写入效果记录并返回到 tool result，由 Session 日志持久化。审计投影通过该 id 关联 Session 决定与效果记录；server 不信任模型提供的审批数据。审计存储失败会阻止 L2 执行。

### 执行与 Temporal 边界

第一版不引入 Temporal。L2 操作是一次幂等 MCP 操作，或提交到现有可靠调度器或 CI 系统；tool 观察该系统的 job id 与结果。当前 `packages/workflow/` worker-thread 引擎可以协调只读证据收集与 subagent，但它不是安全边界，也不是持久生产事务引擎。

只有经过验证的场景需要跨进程重启等待、多系统状态、持久审批暂停、补偿，或 Harness 重启后的重试时，才引入 Temporal。Temporal activity 调用同一套服务端授权 operation，workflow 状态携带相同的 correlation 与幂等 identity。

## 考虑过的替代方案

**创建新的顶层 `agent-platform/` 目录。** 这会重复仓库的 package 分组、profile bundle、Skill 提供方、MCP 桥接器、审批服务和 workflow 能力。私有 experimental package 提供明确的孵化边界，无需引入第二套架构。

**把业务流程实现为大型 MCP tool。** 这会把证据收集与决策步骤隐藏在一次服务端发版之后，使业务所有者无法评审流程。原子 tool 加 Git 评审 skill，使执行权限留在服务端，业务推理留在可评审 SOP 中。

**把 OpenViking 作为权威文档存储。** 运行时检索与提取记忆是可变的派生数据。Git 历史、评审、所有权与回滚使 Vault 成为权威来源；OpenViking 保存来源文档引用并可重建。

**在第一个 milestone 引入 Temporal。** 首批场景为只读或单次幂等有界操作。在衡量到可靠多步骤需求之前，Temporal 会增加运维依赖，同时仍不能把内置 workflow 引擎误认为最终持久层。

## 验收标准

- Experimental profile 能够加载五个 MCP tool、八个 skill、当前权限服务、Session 持久化与固定版本的 OpenViking 集成；profile 组合测试会拒绝缺失的权威组件或重复 namespace。
- 单元测试拒绝 SQL 写入与禁用 schema、NAS 路径穿越与 symlink 越界、过大时间范围与结果、未知 operation id、无效目标、缺失幂等键、包含 secret 的输出，以及审计存储失败。
- MCP 约定测试通过真实 stdio 或 Streamable HTTP 桥接器覆盖取消、超时、重连、结构化结果、server 错误和稳定公开名称。
- 策略测试覆盖所有 L1/L2/L3 与环境组合、限定 scope 的 tool 可见性、单调拒绝、缺失应答者、拒绝、取消与审批不可用。所有不确定状态都故障关闭。
- 无 key profile 快照固定模型可见 tool 目录、Skill 目录、策略上下文、审批结果和脱敏行为。Package 测试固定审计关联，但不存储凭据。
- 可选 staging 测试写入唯一 Vault 资源，在新的合格 Session 中召回它，证明被排除的 subagent 不污染召回，运行一次 L2 dry-run，并通过 correlation id 对账 Session 记录与权威审计记录。
- 生产启用从只读 shadow mode 开始。L2 需要完成 dry-run 观察期、指定所有者、值班恢复说明，并能通过下游系统回滚。L3 保持不可用。

## 风险

- OpenViking 与 DSH 的预发布 API 可能独立变化；精确版本固定与兼容性测试是发版阻断项。
- 如果操作者与留存 scope 错误，Session 派生记忆可能在团队或 subagent 之间泄漏；首版优先隔离并排除语义不明确的 Session。
- 过于宽松的 MCP server 会绕过客户端策略；服务端身份、授权、目标限制和先审计后执行始终必需。
- 仅靠数据库 parser 不能证明安全；只读凭据、获准 schema、超时与结果限制是独立控制。
- 单一 `run_approved_script` 入口可能随着积累变成不受限 shell；每个 operation 都需要独立 schema、所有者、风险等级、测试与允许清单项，原始命令始终禁止。
