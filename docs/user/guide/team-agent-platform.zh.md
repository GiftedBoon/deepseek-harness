---
description: "团队级 Agent 平台参考架构：组合 DeepSeek Harness、Git 管理的 Markdown Vault、OpenViking、MCP tools 与受控运维工作流。"
---

# 构建受控的团队级 Agent 平台

[English](team-agent-platform.md) | 中文

## 概述

这份参考架构使用 DeepSeek Harness 作为 Agent（智能体）运行时，以 Git 管理的 Markdown Vault 作为人工真源，以 OpenViking 作为运行时上下文与记忆，并以 MCP 作为业务和运维系统的能力边界。它面向量化投资机构内部的业务知识问答、数据库与 NAS 查询、日志诊断、已批准脚本执行，以及产品或策略流程。第一版只执行短流程，复用 Harness 现有审批与审计路径，不引入 Temporal。生产变更必须故障关闭、由服务端授权、经过人工审批，并写入独立审计记录。

## 目录

- [目标与边界](#goals-and-boundaries)
- [架构](#architecture)
- [职责划分](#responsibilities)
- [权限、审批与审计](#permissions-approval-and-audit)
- [第一版部署](#version-1-deployment)
- [升级方向](#upgrade-path)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="goals-and-boundaries"></a>
## 目标与边界

该平台为团队提供一个受治理的 Agent 入口，但模型不拥有生产变更的最终决定权。

- 从经过评审的知识与实时只读系统回答产品、策略、交易、运维和事故问题。
- 通过类型化 tool（工具）查询获准的数据库视图、NAS 路径、日志、监控与作业状态。
- 通过允许清单内的脚本完成有界运维操作，并返回验证证据。
- 把业务流程写成可评审的 skill（技能），不把决策隐藏在大型 tool 中。
- 为每次变更保留操作者、请求、审批、执行目标、参数、结果和验证证据。

第一版不允许 Agent 直接执行策略切换、停止交易、修改生产配置、不受限地终止进程、任意写数据库或执行跨系统回滚。此类请求可以产出计划和证据包，但在引入可靠工作流层之前，执行仍留在现有的人工作业系统中。

-----

<a id="architecture"></a>
## 架构

每一层只拥有一种决策。模型可以选择 skill 并请求 tool，但不能自行授予身份、数据范围、审批或生产权限。

```text
Web / CLI / enterprise messaging / API
                    |
          DeepSeek Harness runtime
          session | agent | preset
                    |
       +------------+-------------+
       |            |             |
Git/Vault skills  OpenViking    MCP tools
and knowledge     context       and servers
       |            |             |
       +------------+-------------+
                    |
       policy -> approval -> audit
                    |
 DB views | NAS | logs | monitoring | approved scripts
                    |
       durable workflow tier (later)
```

当前仓库已经提供所需扩展点：[Skill 注册表与文件系统提供方](../../../packages/skill/README.zh.md)、[MCP 客户端桥接器](../../../packages/mcp/mcp-client/README.zh.md)、[tool 执行流水线](../../../packages/core/tools/README.zh.md)、[审批服务](../../../packages/interaction/user-approval/README.zh.md)、[权限预设](../../../packages/interaction/permission-presets/README.zh.md)、[沙箱策略](../../../packages/sandbox/sandbox-policy/README.zh.md)、[Session 日志](../../../packages/session/README.zh.md)与[工作流能力](../../../packages/workflow/README.zh.md)。团队部署通过 profile 组合这些包，再添加业务专用提供方与策略插件；无需修改 `agent-loop`。

-----

<a id="responsibilities"></a>
## 职责划分

知识、记忆、skill 与 tool 由不同角色维护，具有不同评审要求、失败模式和安全权限，因此必须分层。

| 层 | 负责 | 不负责 |
|---|---|---|
| Harness | Agent loop、Session 生命周期、tool 注册与执行、hooks、presets、subagents、审批路由和模型可见上下文 | 业务真值、生产凭据或持久跨系统事务 |
| Git/Vault | 经过评审的 Markdown 知识、runbook、决策记录、skill 源文件、所有权和变更历史 | 单次请求的检索排序或隐藏的可变 Agent 记忆 |
| OpenViking | 运行时检索、profile 与 memory 上下文、Session 捕获、记忆提取和召回 | 审批、生产授权或经过评审流程的权威副本 |
| Skill | 业务 SOP：前置条件、待收集证据、决策点、tool 顺序、验证和升级路径 | 凭据、不受限代码执行或服务端授权的替代品 |
| Tool/MCP server | 一项带输入校验、有界输出、目标限制、超时与可验证结果的类型化能力 | 开放式业务判断或完整的多步骤业务流程 |
| Workflow | 对已经批准的计划执行排序、重试、检查点、补偿与恢复 | 判断调用方是否有权执行，或判断是否需要审批 |

### Skill 与 tool 的分工

Tool 保持原子性，例如 `product_lookup`、`db_query_readonly`、`nas_search`、`log_query` 或 `run_approved_script`。`diagnose-job-failure` 这样的 skill 说明应收集哪些证据、如何解释、何时停止，以及下一步可以运行哪个 tool。不要暴露一个 `switch_strategy_and_do_everything` 巨型 tool：它会隐藏策略决策、阻碍逐步证据评审，并把业务流程变更绑定到服务端发版。

现有 `dsh-skill-filesystem` 提供方发现 workspace 和用户 skill 根目录，`dsh-tool-skill` 发布目录与 loader。团队 skill 存放在团队知识仓库可发现的 `.agents/skills/<name>/SKILL.md` 路径中，让常规 Git 评审治理它们。产品事实与 runbook 不应复制进 `SKILL.md`；skill 应当链接或检索这些事实。

### Vault/Git 与 OpenViking 的分工

Git/Vault 是人工真源。团队编辑 Markdown、评审变更、合并，并可以识别或回滚精确的流程版本。OpenViking 是派生的运行时上下文服务：它摄取已批准来源、检索相关上下文，并按留存策略存储 Session 派生记忆。来自 Vault 的每条 OpenViking 数据都必须保留源仓库、路径、commit、文档所有者、分类与摄取时间，使答案能够引用权威版本。

只有在固定与当前 DSH 版本兼容的版本后，才使用 OpenViking 原生 DSH bundle 自动召回和捕获。其 [DSH 插件文档](https://github.com/volcengine/OpenViking/blob/main/examples/dsh-memory-plugin/README.md)说明生命周期注入、捕获、失败写入重放、URI 保护和记忆 tool。生产启用前，发布验证必须针对固定版本覆盖恢复会话去重、subagent 隔离、删除行为、凭据解析和故障关闭降级。当部署需要由模型显式调用记忆，而不是生命周期集成时，通用[记忆 MCP 指南](mcp-memory.zh.md)仍是回退方案。

-----

<a id="permissions-approval-and-audit"></a>
## 权限、审批与审计

授权必须在产生效果的位置强制执行。Harness 的策略与审批改善控制与用户体验，但即使 Agent 绕过提示词，或客户端插件配置错误，MCP server 或下游服务仍必须拒绝未授权调用方。

| 等级 | 示例 | 执行策略 |
|---|---|---|
| L1 — 只读 | 产品状态、获准 DB 视图、NAS 查询、日志、监控、分析 | 通过身份与资源范围检查后自动执行；仍限制查询、行数、字节与时间 |
| L2 — 有界操作 | 重跑允许清单内的作业、刷新缓存、补拉数据 | 只允许具名操作和类型化参数，要求幂等键、角色与环境检查及完整审计；第一版可要求所有生产操作都审批 |
| L3 — 危险操作 | 切换策略、停止交易、部署生产、修改生产配置或数据、终止进程 | 故障关闭；必须人工审批；第一版返回计划或委托给现有受控系统，不执行多步骤变更 |

用限定 scope 的 tool 可见性移除 Agent 永远不需要的能力；用 `tools/pre-execute` 实现可允许、拒绝或询问的部署策略；用 `ctx.tools.guard()` 实现后续监听器无法推翻的单调拒绝。用 `dsh-user-approval` 完成单操作决策，并把 `approval/asked` 与 `approval/decided` 保留在请求 Session 中。MCP server 产生效果之前，要再次检查身份、角色、目标、环境、维护窗口与允许清单。

Session 日志是 Agent 交互记录，不是唯一的安全审计账本。Harness 记录 tool call 与人工审批；产生效果的服务写入仅追加记录，包含经过认证的操作者、服务端签发的 correlation id、脱敏后的规范化参数、目标、时间、幂等键、结果与验证证据。服务把该 correlation id 返回到 tool result，使审计投影可以关联 Session 决定与效果记录，而无需把模型参数当作权威。审计写入失败时禁止执行 L2 与 L3 操作。凭据使用[凭据能力](../../../packages/credentials/README.zh.md)提供的引用；skill 与 tool 参数都不携带原始秘密。

-----

<a id="version-1-deployment"></a>
## 第一版部署

第一版是一个受控且以只读为主的部署。它复用仓库现有包，并添加[拟议实现 Agent Note](../../../.agents/notes/proposed/feature/2026-09-06-team-agent-platform-mvp.zh.md)中定义的最小部署自有代码。

首批 MCP 能力包含五项操作：

1. `product_lookup` 从获准视图读取规范化的产品、策略、账户与部署元数据。
2. `db_query_readonly` 执行经过验证的只读查询或具名查询模板，并限制 schema、行数、字节与时间。
3. `nas_search` 在允许清单路径中搜索与读取，执行路径规范化、文件类型限制与有界摘录。
4. `log_query` 按服务、主机、时间范围和有界过滤字段查询获准的日志与监控后端。
5. `run_approved_script` 以类型化参数、dry-run、幂等、服务端签发的 correlation id 和后置条件证据调用允许清单中的 operation id；Harness 策略按配置在分发前询问，第一版不包含 L3 操作。

首批 skill 目录包含 `answer-business-question`、`lookup-product-state`、`investigate-strategy-state`、`inspect-production-logs`、`diagnose-job-failure`、`rerun-data-pipeline`、`restart-approved-service` 与 `prepare-strategy-switch`。最后一个 skill 在产出目标状态、当前证据、风险检查、审批要求、执行步骤、验证与回滚计划后停止。

第一版使用 DSH Session 持久化与下游审计存储，不使用 Temporal。有界 L2 操作只能是一次幂等 MCP 调用，或提交到组织现有调度器、CI 服务等可靠作业系统。内置 worker-thread workflow 可以收集证据并协调 subagent，但它提供的是隔离，不是安全或持久边界，也不负责生产变更的可靠性。

-----

<a id="upgrade-path"></a>
## 升级方向

当真实场景需要跨进程重启等待、多系统提交、补偿操作、持久审批暂停，或必须在 Harness 进程退出后继续的重试策略时，再添加可靠工作流引擎。Agent 提交一份类型化且已经批准的工作流请求并观察状态；Temporal activity 调用同一套服务端授权能力，因此引入 Temporal 不会削弱或复制 MCP 授权层。

后续升级可以增加交易关键变更的双人审批、带评审资源规则的 policy-as-code、短期工作负载身份、证据签名的执行报告、OpenTelemetry 关联、带删除传播的 Vault 自动摄取，以及 skill 晋级规则：只有通过回放和生产影子验证后，才从只读建议升级为有界操作。

-----

<a id="further-exploration"></a>
## 进一步探索

- [MCP 客户端桥接器](../../../packages/mcp/mcp-client/README.zh.md)——外部 tool 发现、稳定名称、生命周期与失败行为。
- [Skills 子系统](../../subsystems/skills.zh.md)——提供方、目录、调用与加载约定。
- [Tools 子系统](../../subsystems/tools.zh.md)——限定 scope 的可见性与完整执行策略流水线。
- [审批子系统](../../subsystems/approval.zh.md)——单操作审批与持久审计事件。
- [工作流子系统](../../subsystems/workflow.zh.md)——当前 worker-thread workflow 的语义与限制。
- [第三方记忆 MCP 指南](mcp-memory.zh.md)——本仓库已有的显式记忆服务 overlay。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本页定义目标部署架构，不声称本仓库已经交付业务专用 MCP server、策略插件、profile、Vault 或 OpenViking 集成。拟议 Agent Note 负责第一版实现清单与验收状态。

</details>
