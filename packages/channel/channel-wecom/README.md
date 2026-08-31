---
description: "Enterprise WeCom AI Bot long-connection channel for operators exposing persistent DSH conversations inside WeCom."
kind: "package-reference"
---

# @deepseek-ai/dsh-channel-wecom

English | [中文](README.zh.md)

## Summary

`dsh-channel-wecom` connects one enterprise WeCom intelligent bot to ordinary DSH Workspace Sessions through the official WebSocket long-connection SDK. It accepts outbound-only network deployment, validates and deduplicates text deliveries, serializes each conversation, streams correlated visible Agent output, and retains failed active sends in a durable outbox.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Conversation and delivery lifecycle](#conversation-and-delivery-lifecycle)
- [Security](#security)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="prerequisites"></a>
## Prerequisites

Create an intelligent bot in the enterprise WeCom administration console and enable its long-connection receiving mode. The DSH Host needs outbound TLS access to WeCom but does not need a public callback URL. Store the bot secret and a separate high-entropy Session-identity key through the credentials provider; configuration names references and never embeds either value.

Run this plugin in one long-lived `web` profile or a custom profile layered on `dsh-base`. Exactly one active process may connect with a BotID. The plugin rejects permission presets that can ask a human or use `danger-full-access`; define a deployment preset with `approval: never` and a confined `read-only` or `workspace-write` sandbox.

The [Linux production deployment guide](../../../docs/user/guide/wecom-linux-deployment.md) provides the dedicated profile, unattended preset, systemd, cutover, acceptance, and rollback procedure.

<a id="configuration"></a>
## Configuration

`botId`, `secretEnv`, `sessionKeyEnv`, `workspacePath`, `agentPreset`, `permissionPreset`, `allowedUsers`, `allowedChats`, and `messages` are required. `allowedUsers` and `allowedChats` accept exact provider ids or the explicit `"*"` wildcard. `groupConversationMode` is `shared` by default; `per-user` isolates each group member. `messages` supplies operator-localized processing, timeout, failure, empty-reply, unauthorized, and duplicate-delivery text.

Provider and resource controls are configurable: initial authentication timeout, stream flush interval, UTF-8 input/reply limits, Agent-turn timeout, delivery retention/count, outbox retry interval, and maximum retry attempts. `maxReplyBytes` cannot exceed WeCom's 20,480-byte stream limit. `workspacePath` must be an existing absolute directory.

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
## Conversation and delivery lifecycle

Single chats map by user; groups map by chat or by chat plus user according to `groupConversationMode`. HMAC-SHA-256 derives stored conversation, Session, and delivery keys, so raw WeCom user, chat, and message ids do not become DSH identifiers. The Session key is an identity root: changing it starts new mappings and prevents old conversations from resolving.

The channel persists conversation routing, delivery state, and outbox records in the `channel_wecom` storage domain. Repeated completed or failed deliveries replay their stored final text without invoking the model. Messages in one conversation queue behind each other; other conversations remain independent.

Each admitted message creates or resumes one Agent, mounts the configured agent preset before publication, applies the noninteractive permission preset, attaches a new Session to the configured Workspace, and sends one ordinary user message. The channel correlates `agent/inbox/claimed`, `assistant/chunk`, and `turn/end` by exact Agent, Session, message, and turn. It flushes the Session and disposes the Agent after the interval reaches quiescence.

The first passive reply is `messages.processing`; later cumulative updates contain only `text-delta` output, never reasoning. Passive-final failure falls back to an active Markdown send. If both transports fail, the bounded final text enters the durable outbox and retries after authentication and on the configured interval.

<a id="security"></a>
## Security

Use explicit user and group allowlists in production. Keep `sessionKeyEnv` distinct from the WeCom bot secret and back it up as deployment identity material. The plugin logs validation and transport failures without logging accepted raw provider ids or message text. Agent tools still have the authority of the selected preset, so a channel preset should grant only the workspace and commands the bot actually needs.

<a id="model-experience"></a>
## Model Experience

### WeCom user message

#### What the model sees

The model sees the admitted WeCom text as one ordinary user-role message with `source.kind: "user"`. Transport ids, BotID, allowlist data, placeholders, and retry state are not model-visible. Existing Session history supplies prior conversation context.

#### Token effect

Each admitted message and visible assistant result remains in the ordinary Session log and contributes tokens until compaction changes that history. Channel metadata adds no model tokens.

#### KV Cache effect

Resuming the same mapped Session preserves its reusable conversation prefix. Changing the Session identity key or group ownership mode maps future messages to another Session and starts a new prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text input only** — images, mixed messages, voice, files, video, cards, and welcome events are not admitted.
- **One active replica per BotID** — the package has no leader election or distributed conversation lock.
- **Credential reload requires reconnection** — bot secret and Session identity key are resolved at plugin activation; rotate them by reloading the plugin.
- **Bounded reply projection** — replies longer than `maxReplyBytes` are truncated with an ellipsis; tools and reasoning are not rendered into WeCom.
- **No inbound durable queue before admission** — the official SDK owns reconnect behavior, while provider callbacks that never reach this process cannot be replayed by DSH.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The provider SDK is isolated behind `WeComChannelClient`; deterministic tests must use that interface and must not open external sockets.

</details>
