# 企业消息渠道

[English](channel.md) | 中文

渠道把企业消息传输接入普通 Session。[渠道包](../../packages/channel/README.zh.md)负责消息准入、会话路由和提供方连接。

## Host 主动通知

已连接的企业微信渠道配置精确的白名单 `notificationChatId` 后提供 `ctx.weComNotifications`。Host 消费者将 Markdown 入队，不创建 Agent 回合或另一个提供方连接。返回的 Promise 仅确认持久化入队；提供方投递和有限重试是独立步骤。卸载渠道会移除服务、拒绝新的入队，并在关闭存储前等待已开始的持久化工作结束。配置和投递限制由[企业微信渠道](../../packages/channel/channel-wecom/README.zh.md)定义。

## 定时 Agent 执行

企业微信通过 [Schedule 执行器](../../packages/schedule/schedule/README.zh.md)管理其映射 Session 的任务执行和报告路由。任务结算将持久化输入消息与领取该消息的轮次及已提交的助手消息关联；渠道的投递、权限、恢复和保留规则由[企业微信渠道](../../packages/channel/channel-wecom/README.zh.md#conversation-and-delivery-lifecycle)定义。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwecomnotifications--wecomnotifications"></a>

### `ctx.weComNotifications` — `WeComNotifications`

Host-generated Markdown notifications using the channel's existing connection and durable outbox.

```ts cordis-catalog
/**
 * Persist a report for the configured exact allowlisted group.
 * @param content - Markdown bounded by the channel's reply byte limit.
 * @returns Resolves after durable queue admission, not provider receipt; rejects on storage failure or disposal.
 */
enqueue(content: string): Promise<void>
```

Source: [`packages/channel/channel-wecom/src/types.ts`](../../packages/channel/channel-wecom/src/types.ts)
<!-- END GENERATED cordis-surface -->
