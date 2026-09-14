# Agent Note: 可定时的产品级动作（Trader Ops 企业微信渠道）

Status: proposed

[English](2026-09-14-schedulable-product-actions.md) | 中文

## Problem

Trader Ops 企业微信渠道从一份封闭的部署条目清单登记持久动作，而现有每条都派发 `mcp__bssh-ops-remote__run_quick_command`：`ps_check`、`quick_command` 和 `custom_shell`。因此，在未来时刻指定产品级操作的请求——"17:32 开 HJ1 的策略，17:34 杀掉"——无法按操作者说出的那个操作被定时。模型唯一可用的路径，是用此前 `preview_product_action` 返回的命令文本，为每台 colo 各排一条裸 `custom_shell`。

这条回退路径同时改变了记录的含义和它的保护：

- **产品身份没有留存。** 记录的 `target` 装的是 colo，因此到期通知与 bssh_ops 审计条目陈述的是"某条 shell 在两台机器上跑过"，而不是"HJ1 被杀掉了"。
- **产品归属在预览时被冻结。** `preview_product_action` 按当前归属解析产品的 colo，而定时记录持久化的是这个派生结果。归属可能在派发前变化，记录却仍指向更早解析出的机器。定时动作的指纹保护的是 Harness 侧的动作定义，不是目标的持续有效性。
- **命令失去了与已评审动作的绑定。** `execute_product_action` 从已评审的产品动作渲染命令，而 `custom_shell` 承载的是一个仅受 UTF-8 字节上限约束的不透明字符串。

定时机制也表达不了这个产品操作：一条定时动作只承载一个目标（可包成单元素数组），外加至多一个模型提供的字符串；而双中心产品需要两台 colo 加一条命令。本提案复用[参数化企业微信定时动作](../../implemented/feature/2026-09-14-parameterized-wecom-scheduled-actions.zh.md)记录下来的 `input` 机制。

## Proposal

登记一条定时动作，承载操作者说出的那两个值：产品和封闭的动作 key。

### 服务端入口

bssh_ops 增加一个在调用到达时解析产品的入口，与 `preview_product_action` 已经做的解析一致：

| 方面 | 要求 |
|---|---|
| 输入 | `product`（准确产品名）与 `action`（来自已评审动作集的 key） |
| key 来源 | `list_product_actions` 返回的 id，或已评审的改参命令白名单，如 `kill`、`start`、`open_t0`、`close_t0` |
| 行为 | 解析产品当前 colo、渲染已评审命令、执行单/双中心不变量、授权、按 colo 执行，并写入一条点名产品与动作 key 的审计记录 |
| 输出 | 一个 `run_id` 与每台 colo 的结果，与其他写工具一致 |

key 集必须封闭且可枚举，使模型选择 key 而不是构造命令。

### Harness 侧登记

在 [`trader-ops-wecom.patch.yml`](../../../../deployments/trader-ops/config/dsh/trader-ops-wecom.patch.yml) 中增加一条：

```yaml
- id: product_action
  description: Run one reviewed product-level action on the product's current colos.
  toolName: mcp__bssh-ops-remote__run_product_action
  targetArgument: product
  targetPattern: '^[A-Za-z0-9_.-]+$'
  input:
    toolArgument: action
    description: Exact key returned by list_product_actions.
    maxBytes: 64
    pattern: '^[A-Za-z0-9_.-]+$'
```

不需要改动任何包：现有的 `target` 与 `input` 两个槽位就能承载这两个值，形状与 `quick_command` 用 colo 加快捷命令 key 时相同。随它一起落地的是两项部署自有工作：在 [`tool-access.yaml`](../../../../deployments/trader-ops/policies/tool-access.yaml) 中为新工具分类，以及在 [`bssh-ops` Skill](../../../../deployments/trader-ops/skills/bssh-ops/SKILL.md) 中增加产品级定时流程。

### 派发时授权

定时派发本来就会重新解析动作定义并重跑工具策略。本提案把产品解析放到同一条派发路径上，于是归属、动作定义与授权都在副作用发生时被评估，而不是在登记时。

## Alternatives considered

**给 `packages/channel/channel-wecom` 增加多元素目标格式。** 把 `targetArgumentFormat` 扩展出数组形态，就能让一条记录承载双中心产品的 `confirmed_colos` 加 `confirmed_shell`，从而直接登记 `execute_product_action`。它落选是因为它持久化的是派生值，而操作者给出的是身份：产品名没有槽位，归属在预览时就被冻结，审计条目报告的是 colo 和一段 shell。它还为一个由产品语义定义的使用场景扩大了通用定时机制的表达力。

**把 `execute_product_action` 登记成每台 colo 一条记录。** 这在今天就能表达，因为 `singleton-array` 可以包住单台 colo，`input` 可以承载 `confirmed_shell`。它保留了与已评审动作的绑定，但把一个操作者可见的操作拆成两条彼此独立的记录，各自只声明一台 colo，而且仍然冻结预览时解析出的归属。部分失败会让产品停在没有任何记录能描述的半应用状态。

**保留"每台 colo 一条 `custom_shell`"的回退。** 这正是引出本笔记的现状行为。它被否，因为它丢弃了产品身份与已评审动作的绑定，并且把目标有效性只留在预览那一刻校验。

**在定时记录里承载结构化 `rules` 数组。** 定时任意一套 `preview_change_cfg_paras` 规则需要结构化输入，而不是一个字符串。它不在本次范围内：已评审的 key 形态覆盖了日常的策略启停请求，而任意规则集没有可枚举的已评审 key。

## Acceptance criteria

- `scheduled_action_create` 提供一个产品级动作，其 `action` 参数只枚举服务端提供的 key。
- 为产品 HJ1 创建、并在归属变化后派发的记录，作用于 HJ1 当前的 colo，且其审计条目点名产品与动作 key。
- 未知 key 在创建时失败关闭；在派发前失效的 key 在派发时失败关闭，并把失败报告到会话。
- 该登记不为 `packages/channel/channel-wecom` 增加任何包依赖或新配置字段。

## Risks

- **key 集必须保持封闭且经过评审。** 服务端若接受任意 key，就会重新引入本提案要消除的不透明命令属性。
- **派发时解析可能作用于与操作者预览不同的 colo 集。** 这是有意的取舍：不变量是产品身份，而不是机器清单。到期通知必须说明解析出的 colo，让差异可见。
- **契约位于本仓库之外。** 在 bssh_ops 服务交付该入口之前，没有任何东西能按产品定时；本笔记只记录契约。
