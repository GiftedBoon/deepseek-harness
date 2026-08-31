---
description: "面向需要在企业微信中提供持久 DSH 对话的运维人员，说明企业微信智能机器人长连接渠道。"
kind: "package-reference"
---

# @deepseek-ai/dsh-channel-wecom

[English](README.md) | 中文

## 概述

`dsh-channel-wecom` 通过官方 WebSocket 长连接 SDK，把一个企业微信智能机器人连接到普通 DSH Workspace Session。它适合仅开放出站网络的部署，负责验证和去重文本交付、串行处理每个会话、流式返回已关联的可见 Agent 输出，并将主动发送失败保留在持久 outbox 中。

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

`botId`、`secretEnv`、`sessionKeyEnv`、`workspacePath`、`agentPreset`、`permissionPreset`、`allowedUsers`、`allowedChats` 与 `messages` 是必填项。`allowedUsers` 和 `allowedChats` 接受准确的提供方 id 或显式通配符 `"*"`。`groupConversationMode` 默认为 `shared`；`per-user` 会隔离群内每个成员。`messages` 提供由运维人员本地化的处理中、超时、失败、空回复、未授权与重复交付文案。

提供方与资源控制项均可配置：首次认证超时、流式刷新间隔、UTF-8 输入／回复上限、Agent turn 超时、交付保留时间／数量、outbox 重试间隔与最大重试次数。`maxReplyBytes` 不能超过企业微信的 20,480 字节流式上限。`workspacePath` 必须是现存的绝对目录。

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
    messages:
      processing: '正在处理…'
      timeout: '处理超时，请稍后重试。'
      failure: '处理失败，请稍后重试。'
      emptyReply: '任务已完成，但没有文本回复。'
      unauthorized: '当前用户或会话未获授权。'
      duplicate: '该消息正在处理中。'
```

<a id="conversation-and-delivery-lifecycle"></a>
## 会话与交付生命周期

单聊按用户映射；群聊根据 `groupConversationMode` 按群或按群加用户映射。HMAC-SHA-256 派生存储的会话、Session 与交付键，因此企业微信原始用户、群聊和消息 id 不会成为 DSH 标识符。Session 密钥是身份根：修改它会开始新的映射，并使旧会话无法继续解析。

渠道在 `channel_wecom` storage domain 中持久保存会话路由、交付状态和 outbox 记录。重复的已完成或已失败交付会直接重放存储的最终文本，不会再次调用模型。同一会话中的消息依次排队；不同会话彼此独立。

每条准入消息都会创建或恢复一个 Agent，在发布前挂载已配置的 agent preset，应用非交互权限 preset，把新 Session 附加到已配置 Workspace，并发送一条普通用户消息。渠道通过准确的 Agent、Session、消息与 turn 关联 `agent/inbox/claimed`、`assistant/chunk` 和 `turn/end`。该区间静止后，渠道会 flush Session 并释放 Agent。

第一次被动回复是 `messages.processing`；后续累计更新只包含 `text-delta` 输出，绝不包含 reasoning。被动最终回复失败时会退回到主动 Markdown 发送。两种传输都失败时，受限长度的最终文本会进入持久 outbox，并在认证后及每个已配置间隔重试。

<a id="security"></a>
## 安全

生产环境应使用明确的用户与群聊白名单。让 `sessionKeyEnv` 与企业微信机器人 secret 保持独立，并把它作为部署身份材料备份。插件记录验证与传输失败，但不会记录已准入的原始提供方 id 或消息文本。Agent 工具仍具有所选 preset 的权限，因此渠道 preset 应只授予机器人确实需要的 Workspace 和命令。

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

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

提供方 SDK 隔离在 `WeComChannelClient` 后；确定性测试必须使用该接口，并且不能打开外部 socket。

</details>
