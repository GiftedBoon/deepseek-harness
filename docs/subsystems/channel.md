# Enterprise messaging channels

English | [中文](channel.zh.md)

Channels connect enterprise messaging transports to ordinary Sessions. The [channel packages](../../packages/channel/README.md) own delivery admission, conversation routing, and provider connections.

## Host notifications

A connected WeCom channel configured with an exact allowlisted `notificationChatId` publishes `ctx.weComNotifications`. Host consumers enqueue Markdown without creating an Agent turn or another provider connection. The returned promise acknowledges durable outbox admission; provider delivery and bounded retries are separate. Unloading the channel removes the service, rejects new admissions, and drains owned persistence work before closing storage. Configuration and delivery limits belong to the [WeCom channel](../../packages/channel/channel-wecom/README.md).

## Scheduled Agent execution

WeCom owns execution and report routing for its mapped Sessions through the [Schedule executor](../../packages/schedule/schedule/README.md). Task settlement correlates the durable input message with its claimed turn and committed assistant messages; channel-specific delivery, authority, recovery, and retention rules belong to the [WeCom channel](../../packages/channel/channel-wecom/README.md#conversation-and-delivery-lifecycle).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
