---
description: "面向 Trader Ops 部署的默认拒绝 YAML 工具策略，通过 tools/pre-execute 给出审批决策，并以单调 guard 防止绕过。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-quant-tool-policy

[English](README.md) | 中文

## 概述

这个私有实验插件把经过评审的 YAML 文件变成真正的 Harness 侧执行边界。它按已配置环境解析首条匹配规则，通过 `tools/pre-execute` 返回 `allow`、`ask` 或 `deny`，并用 `ctx.tools.guard()` 重复拒绝边界。未匹配工具默认拒绝。重复 guard 是有意的：即使另一个 pre-execute 监听器提前结束 waterfall、导致本插件未执行，该调用仍会失败关闭。

它只是一层纵深防御，不是完整授权系统。业务 MCP 服务仍必须在服务边界再次认证调用者、授权资源与参数、校验审批记录并记录审计。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 `ctx.tools` 可用后挂载插件，并显式传入策略路径和环境：

```yaml
- name: '@deepseek-ai/dsh-experimental-quant-tool-policy'
  config:
    policyFile: ./deployments/trader-ops/policies/tool-access.yaml
    environment: development
```

环境必须是 `development`、`staging` 或 `production`，不会推断默认值。策略必须声明版本 1、`enforced: true` 与 `default: deny`。每条规则只能选择精确 `tools` 或一个使用 `*` 的锚定通配 `tool_pattern`：

```yaml
version: 1
status: experimental
enforced: true
default: deny

rules:
  - id: product-read
    tool_pattern: mcp__trader_ops__get_*
    risk: read_only
    environments: [development, staging, production]
    decision: allow

  - id: strategy-write
    tools: [mcp__trader_ops__switch_strategy]
    risk: privileged_operation
    environments: [production]
    decision: require_approval
```

规则顺序就是优先级：环境和工具都匹配的第一条规则生效。`require_approval` 会变成 Harness 的 `ask` 决策；当前组合没有审批服务时，Harness 会拒绝调用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件在加载时读取并校验一份不可变策略快照。无效 YAML、不支持的值、重复规则 ID、含糊选择器、`enforced: false`，以及非 deny 的默认决策都会阻止插件启动。

pre-execute 监听器记录确实经过本策略的 `ToolExecution` 对象。允许调用会继续交给后续监听器，审批规则返回 `ask`，拒绝规则返回 `deny`。单调 guard 随后拒绝显式/默认 deny，也会拒绝没有经过监听器的执行。任何 guard 都不能强制允许其他策略已经拒绝的调用。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | YAML 校验、首条匹配解析、pre-execute 决策与单调 guard |
| [`tests/policy.spec.ts`](tests/policy.spec.ts) | 校验、allow/ask/deny、防绕过与真实 Loader 路径覆盖 |
| — | 不发布 invariant companion；插件不拥有持久状态或事件历史关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Tools 子系统](../../../docs/subsystems/tools.zh.md)——pre-execute、审批、guard、dispatch 与 result 流水线。
- [Trader Ops 策略目录](../../../deployments/trader-ops/policies/README.zh.md)——部署规则，以及 Harness 与 MCP 执行边界的分工。
- [实验包规则](../AGENTS.md)——私有包命名与发布隔离。

-----

<a id="model-experience"></a>
## 模型体验

### 条件审批或拒绝

#### 模型看到什么

插件不增加 prompt 或工具 schema。`allow` 调用保持不变；`require_approval` 打开已配置的审批流程；拒绝或未匹配调用把策略原因作为工具错误返回。

#### Token 影响

允许调用为零 token。审批与拒绝只增加 Harness 既有审批界面或一条短错误结果。

#### KV Cache 影响

仅追加；策略结果出现在可复用请求前缀之后，不会使此前 KV-cache 条目失效。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **仅有 Harness 侧身份**——此版本按环境与工具名分类，尚未消费可信 actor、role、tenant 或 resource 身份。
- **没有参数级策略**——产品归属、交易时段、目标策略有效性等业务约束，在出现可信类型化策略输入前属于 MCP 服务。
- **加载时快照**——修改 YAML 后需要重新加载 Profile 或重启进程。
- **不能替代 MCP 授权**——能绕过 Harness 直连 MCP 服务的调用者也会绕过此插件，因此服务必须重复授权和审计。
- **实验约定**——晋升为正式 guard 包之前，schema 与包名可能变化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

等可信身份/审批服务约定和具体 Trader Ops MCP 服务成型后再考虑晋升。策略输入必须来自服务端；绝不能从模型文本、检索知识或模型提供的工具参数推断授权。

</details>
