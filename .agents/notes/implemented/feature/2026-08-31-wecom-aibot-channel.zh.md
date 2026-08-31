# Agent Note: 企业微信智能机器人渠道

Status: implemented

[English](2026-08-31-wecom-aibot-channel.md) | 中文

## 问题

内网 DSH 部署需要让用户从企业微信继续普通 Agent 对话，同时不暴露入站 HTTP。与即发即弃 webhook 工作不同，每条消息都需要已关联的可见结果、稳定会话归属、重复抑制，以及被动回复失败后的恢复。存在其他工作时，单独使用 `Agent.whenIdle()` 无法识别哪个提示拥有输出。

## 决策

`@deepseek-ai/dsh-channel-wecom` 是基于企业微信智能机器人官方 WebSocket SDK 的长期运行协议驱动器。它是函数插件，因为没有其他包消费企业微信传输操作；它消费现有 Agent、Session、Workspace、preset、permission、credential 与 storage service。

HMAC-SHA-256 把提供方会话和交付 id 映射为稳定的不透明键。单聊归属于用户；群聊由部署选择共享或按用户隔离。键密钥与机器人凭据分离，并作为持久身份材料。

每个会话拥有一条进程内 Promise 队列。一次交付创建或恢复一个 Agent，在发布前挂载 preset，应用受限的非交互权限 preset，并排入一条普通用户消息。准确的 Agent、Session、消息与已分配 turn 关联只允许该 turn 的 `assistant/chunk` 文本增量通过。runtime 等待对应 `turn/end`，达到静止后 flush Session，并在处理该会话下一条消息前释放 handle。

`channel_wecom` domain 存储会话路由、交付状态与主动发送 outbox。已完成和已失败的重复交付会重放存储文本，不再调用模型。被动流更新采用累计内容、合并刷新、顺序发送与 UTF-8 长度限制。最终被动回复失败时退回到主动 Markdown；再次失败会把结果提交到 outbox 进行有界重试。

## 安全与生命周期

Wire 准入检查 BotID、文本类型、UTF-8 大小、发送者白名单与群聊白名单。原始提供方 id 和已准入消息文本不会出现在 DSH 标识符与日志中。插件拒绝带交互审批或 `danger-full-access` 的权限 preset。

释放过程会隐藏 listener、停止重试、中止活动区间、断开 SDK、排空会话队列与 Agent handle，最后关闭 storage。SDK 负责认证、心跳与重连行为。每个 BotID 只允许一个活动进程；分布式 leader election 不属于本包。

## 与 webhook ingress 的关系

本决策不取代 [即发即弃 webhook Session](2026-08-22-fire-and-forget-webhook-sessions.zh.md)。Webhook 分发明确不拥有交付数据库、结果或重试语义。企业微信对话消费 Agent 输出，因此需要全部三项能力；合并两者会削弱 webhook contract，或把渠道生命周期隐藏在适配器中。

## 考虑过的替代方案

**使用企业微信群 webhook 机器人。** 拒绝，因为出站 webhook 机器人不提供双向智能机器人消息流与已关联被动回复。

**为每个群聊保持一个长期活动 Agent。** 拒绝，因为空闲 Agent 会保留 scoped 资源并使重载复杂化。每次交付激活既复用持久 Session 状态，也明确资源归属。

**用原始用户或群聊 id 作为 Session id。** 拒绝，因为 Session id 出现在 API、持久化与诊断中。HMAC 保留稳定路由，同时不公开提供方标识符。

**投影每个 Session 事件。** 拒绝，因为 reasoning 和工具事件不是回复内容，而自主事件可能属于另一个区间。

## 验证

测试覆盖不透明身份与群聊归属、敌对 wire 准入、SDK 日志抑制、UTF-8 限制、累计合并与顺序结束。类型检查覆盖 SDK 适配器与 Host service。仓库 gate 覆盖元数据、文档配对、生成目录、依赖策略与 invariant companion。

## 结果

- 部署需要出站企业微信连接，但不需要公网回调 listener。
- Web Workspace 历史仍是权威对话记录。
- 运维人员必须保留身份密钥并配置明确白名单。
- 不支持媒体消息、卡片、横向扩展与入站重放。
