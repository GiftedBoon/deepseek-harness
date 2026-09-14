---
description: "面向需要在企业微信中提供持久 DSH 对话的运维人员，说明企业微信智能机器人长连接渠道。"
kind: "package-reference"
---

# @deepseek-ai/dsh-channel-wecom

[English](README.md) | 中文

## 概述

`dsh-channel-wecom` 通过官方 WebSocket 长连接 SDK，把一个企业微信智能机器人连接到普通 DSH Workspace Session。它适合仅开放出站网络的部署，负责验证和去重文本交付、串行处理每个会话、流式返回已关联的可见 Agent 输出、从持久 outbox 重试失败的主动发送直到该会话再次写来消息，并可在持久化的未来时刻执行部署白名单工具。

## 目录

- [前置条件](#prerequisites)
- [配置](#configuration)
- [会话与交付生命周期](#conversation-and-delivery-lifecycle)
- [安全](#security)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="prerequisites"></a>
## 前置条件

在企业微信管理后台创建智能机器人并启用长连接接收模式。DSH Host 需要能够通过 TLS 出站访问企业微信，但不需要公网回调地址。通过 credentials provider 保存机器人 secret 和另一个独立的高熵 Session 身份密钥；配置只填写引用名称，绝不嵌入任何密钥值。

请在一个长期运行的 `web` profile 或基于 `dsh-base` 的自定义 profile 中运行该插件。同一 BotID 只能连接一个活动进程。插件会拒绝可能向人工提问或使用 `danger-full-access` 的权限 preset；请定义一个 `approval: never` 且采用 `read-only` 或 `workspace-write` 受限沙箱的部署 preset。

[Linux 生产部署指南](../../../docs/user/guide/wecom-linux-deployment.zh.md)提供专用 profile、无人值守 preset、systemd、切换、验收与回滚流程。

<a id="configuration"></a>
## 配置

`botId`、`secretEnv`、`sessionKeyEnv`、`workspacePath`、`agentPreset`、`permissionPreset`、`allowedUsers`、`allowedChats` 与 `messages` 是必填项。`allowedUsers` 和 `allowedChats` 接受准确的提供方 id 或显式通配符 `"*"`。`groupConversationMode` 默认为 `shared`；`per-user` 会隔离群内每个成员。`messages` 提供由运维人员本地化的交付回复和定时动作通知。

提供方与资源控制项均可配置：首次认证超时、流式刷新间隔、UTF-8 输入／回复上限、Agent turn 超时、交付保留时间／数量、outbox 重试间隔、周期性最大重试次数、未投递 outbox 的保留时间、定时动作数量／时间范围、后台执行超时，以及解析仅含时间的请求时使用的固定 UTC 偏移。`maxReplyBytes` 不能超过企业微信的 20,480 字节流式上限。`workspacePath` 必须是现存的绝对目录。

`scheduledActions` 默认为空。每个配置项把一个稳定动作 id 映射到准确的已注册工具、静态无损 JSON 参数、一个接收请求目标的顶层参数，以及一个带首尾锚点的目标校验表达式。`targetArgumentFormat` 默认为 `scalar`；下游工具要求单元素目标数组时使用 `singleton-array`。可选的 `input` 会把模型可见的 `scheduled_action_create.input` 字符串映射到另一个顶层工具参数，应用必填的 UTF-8 字节上限与可选的首尾锚点表达式，并把原值持久保存到实际调度时。模型不能替换已配置的工具或静态参数。

```yaml
- name: '@deepseek-ai/dsh-channel-wecom'
  config:
    botId: 'your-bot-id'
    secretEnv: WECOM_BOT_SECRET
    sessionKeyEnv: WECOM_SESSION_KEY
    workspacePath: '/srv/agent-workspace'
    agentPreset: coding
    permissionPreset: wecom-channel
    allowedUsers: ['zhangsan']
    allowedChats: []
    groupConversationMode: shared
    scheduledActionUtcOffset: '+08:00'
    scheduledActions:
      - id: health_check
        description: Run the read-only service health check.
        toolName: example_health_check
        targetArgument: host
        targetPattern: '^[a-z0-9-]+$'
        arguments:
          mode: summary
        input:
          toolArgument: query
          description: Exact operator-approved query.
          maxBytes: 1024
    messages:
      processing: '正在处理…'
      timeout: '处理超时，请稍后重试。'
      failure: '处理失败，请稍后重试。'
      emptyReply: '任务已完成，但没有文本回复。'
      unauthorized: '当前用户或会话未获授权。'
      duplicate: '该消息正在处理中。'
      scheduledActionSuccess: '定时动作执行成功'
      scheduledActionFailure: '定时动作执行失败'
      scheduledActionUncertain: '定时动作的执行结果不确定；系统未自动重放'
      scheduledActionDefinitionUnavailable: '定时动作的配置已变更、被移除或缺少已保存输入'
```

<a id="conversation-and-delivery-lifecycle"></a>
## 会话与交付生命周期

单聊按用户映射；群聊根据 `groupConversationMode` 按群或按群加用户映射。HMAC-SHA-256 派生存储的会话、Session 与交付键，因此企业微信原始用户、群聊和消息 id 不会成为 DSH 标识符。Session 密钥是身份根：修改它会开始新的映射，并使旧会话无法继续解析。

渠道在 `channel_wecom` storage domain 中持久保存会话路由、交付状态和 outbox 记录。独立的 `channel_wecom_scheduled_action` domain 会保留待执行和执行中的后台动作，而不改变已发布的渠道 domain generation；`channel_wecom_scheduled_action_input` 会保存可选的参数化输入，而不改变已发布的动作记录格式。重复的已完成或已失败交付会直接重放存储的最终文本，不会再次调用模型。同一会话中的消息依次排队；不同会话彼此独立。

每条准入消息都会先在持久化中观察其映射的 Session，然后创建或恢复一个 Agent，在发布前挂载已配置的 agent preset，应用非交互权限 preset，把新 Session 附加到已配置 Workspace，并发送一条普通用户消息。如果映射的 Session 在渠道持续运行期间被删除，下一条消息会使用同一个稳定 id 创建新 Session，而不会尝试恢复已不存在的日志。渠道通过准确的 Agent、Session、消息、turn 和 attempt 关联 `agent/inbox/claimed`、`agent/assistant-stream` 和 `turn/end`。该区间静止后，渠道会 flush Session 并释放 Agent。

第一次被动回复是 `messages.processing`；后续累计更新只包含 `text-delta` 输出，绝不包含 reasoning。被动最终回复失败时会退回到主动 Markdown 发送。两种传输都失败时，受限长度的最终文本会进入持久 outbox，并在认证后及每个已配置间隔重试。当某条记录达到 `maxOutboxAttempts` 后周期性重试停止，它转而等待所属会话写来消息，届时立即投递；一直无法投递的记录在 `outboxRetentionMs` 之后被删除。每次失败尝试都会记录尝试次数与提供方诊断，绝不记录目标或正文。

当 `scheduledActions` 非空时，映射 Agent 会获得 `scheduled_action_create`、`scheduled_action_list` 与 `scheduled_action_delete`。显式 RFC 3339 `at` 值保留自身的偏移；仅含时间的 `HH:mm[:ss]` 值会按 `scheduledActionUtcOffset` 解析为下一次发生时点，因此模型不需要 shell 或时钟工具。创建操作会先持久保存任何已校验的动态输入，再提交白名单动作并启动计时器，因此释放按交付创建的 Agent 不会取消任务。到点时，渠道会解析当前白名单，要求其指纹与创建时的定义一致，并通过普通全局 policy 和 guard 流程调用已配置工具。结果会先进入持久 outbox，然后删除任务与输入。启动时会重新启用 pending 任务、删除孤立输入，并报告恢复出的 `running` 任务结果不确定；它不会再次执行该任务，因为此前的副作用可能已经发生。

<a id="security"></a>
## 安全

生产环境应使用明确的用户与群聊白名单。让 `sessionKeyEnv` 与企业微信机器人 secret 保持独立，并把它作为部署身份材料备份。发送者或群聊被拒绝时，warning 会把准确 `userid` 或 `chatid` 记录为 JSON 引号字符串，供运维人员建立对应白名单；因此 journal 访问权与保留期必须保护身份标识。插件绝不记录已准入的原始提供方 id 或消息文本。Agent 工具仍具有所选 preset 的权限，因此渠道 preset 应只授予机器人确实需要的 Workspace 和命令。定时动作在实际调度时仍必须获工具 policy 允许。暴露任意 shell 的部署必须要求用户准确确认、限制目标与输入字节数，并禁止在静态参数或模型输入中保存凭据及其他敏感值。

<a id="model-experience"></a>
## Model Experience

### 企业微信用户消息

#### What the model sees

模型会把准入的企业微信文本看作一条 `source.kind: "user"` 的普通 user-role 消息。传输 id、BotID、白名单数据、占位文本和重试状态对模型不可见。现有 Session 历史提供此前对话上下文。

#### Token effect

每条准入消息与可见 assistant 结果都会保留在普通 Session 日志中，并持续贡献 token，直到 compaction 改变该历史。渠道元数据不增加模型 token。

#### KV Cache effect

恢复相同映射的 Session 会保留可复用的对话前缀。修改 Session 身份密钥或群聊归属模式会把后续消息映射到另一个 Session，并开始新的前缀。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **仅文本输入** — 不准入图片、图文混排、语音、文件、视频、卡片与欢迎事件。
- **每个 BotID 仅一个活动副本** — 本包没有 leader election 或分布式会话锁。
- **凭据重载需要重新连接** — 机器人 secret 与 Session 身份密钥在插件激活时解析；轮换后请重新加载插件。
- **回复投影有长度限制** — 超过 `maxReplyBytes` 的回复会用省略号截断；工具与 reasoning 不会渲染到企业微信。
- **准入前没有入站持久队列** — 官方 SDK 负责重连，而从未到达本进程的提供方回调无法由 DSH 重放。
- **定时结果是渠道通知** — 后台结果会发送到企业微信并由被调用工具审计，但不会作为模型生成的会话历史插入 Session。
- **未投递的通知会等待所属会话** — 提供方在会话空闲时拒收的通知，会在该会话下一次写来消息时投递；若在 `outboxRetentionMs` 内始终未能投递，该记录会被删除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

提供方 SDK 隔离在 `WeComChannelClient` 后；确定性测试必须使用该接口，并且不能打开外部 socket。

</details>
