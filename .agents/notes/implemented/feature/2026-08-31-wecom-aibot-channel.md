# Agent Note: Enterprise WeCom AI Bot channel

Status: implemented

English | [中文](2026-08-31-wecom-aibot-channel.zh.md)

## Problem

An internal DSH deployment needs users to continue ordinary Agent conversations from enterprise WeCom without exposing inbound HTTP. Unlike fire-and-forget webhook work, each message needs a correlated visible result, stable conversation ownership, duplicate suppression, and recovery after passive reply failure. `Agent.whenIdle()` alone cannot identify which prompt owns output when other work exists.

## Decision

`@deepseek-ai/dsh-channel-wecom` is a long-lived protocol driver over the official WeCom AI Bot WebSocket SDK. It is a function plugin because no other package consumes WeCom transport operations; it consumes existing Agent, Session, Workspace, preset, permission, credential, and storage services.

HMAC-SHA-256 maps provider conversation and delivery ids to stable opaque keys. Single chats belong to a user; group chats are deployment-selected as shared or per-user. The key secret is separate from the bot credential and is durable identity material.

Each conversation has a process-local promise queue. One delivery observes its deterministic Session id through `SessionPersistence.stat()`, creates or resumes one Agent from that current result, mounts the preset before publication, applies a confined noninteractive permission preset, and queues one ordinary user message. A Session deleted while the channel remains active is recreated under the same id on the next delivery. Exact Agent, Session, message, allocated-turn, and attempt correlation admits only that turn's `agent/assistant-stream` text deltas. The runtime waits for its `turn/end`, reaches quiescence, flushes the Session, and disposes the handle before processing the next message in that conversation.

The `channel_wecom` domain stores conversation routing, delivery state, and an active-send outbox. Completed and failed duplicates replay stored text without another model call. Passive stream updates are cumulative, coalesced, ordered, and UTF-8 bounded. Final passive failure falls back to active Markdown; another failure commits the result to the outbox for bounded retry.

## Security and lifecycle

Wire admission checks BotID, text type, UTF-8 size, sender allowlist, and group allowlist. Raw provider ids remain absent from DSH identifiers. A denied sender warning records only the exact JSON-quoted `userid` needed to build an allowlist; accepted provider ids, message text, and callback frames remain absent from logs. Trader Ops mounts a console exporter at the channel warning level so systemd records the warning. The plugin rejects permission presets with interactive approval or `danger-full-access`.

Trader Ops operator scripts project only rejected-user timestamps and ids from the journal, apply exact user and group-chat allowlist additions or removals through the validated configurator, and restart Harness with readiness and restart-stability checks. Allowlist changes preserve unspecified entries and require at least one admitted user.

Disposal hides listeners, stops retries, aborts active intervals, disconnects the SDK, drains conversation queues and Agent handles, then closes storage. The SDK owns authentication, heartbeat, and reconnect behavior. One active process per BotID is required; distributed leader election is outside this package.

## Relationship to webhook ingress

This decision does not supersede [Fire-and-forget webhook Sessions](2026-08-22-fire-and-forget-webhook-sessions.md). Webhook dispatch intentionally has no delivery database, result, or retry semantics. The WeCom conversation consumes Agent output and therefore needs all three; combining them would weaken the webhook contract or hide channel lifecycle in an adapter.

## Alternatives considered

**Use a WeCom group webhook robot.** Rejected because outbound webhook robots do not provide the bidirectional intelligent-bot stream and correlated passive replies.

**Keep one Agent live for every chat.** Rejected because idle Agents retain scoped resources and complicate reload. Per-delivery activation reuses durable Session state with explicit ownership.

**Use raw user or chat ids as Session ids.** Rejected because Session ids appear in APIs, persistence, and diagnostics. HMAC preserves stable routing without publishing provider identifiers.

**Project every Session event.** Rejected because reasoning and tool events are not reply content, while autonomous events may belong to another interval.

## Verification

Tests cover opaque identity and group ownership, fresh creation after deletion, hostile wire admission, SDK log suppression, UTF-8 bounds, cumulative coalescing, and ordered finalization. Type checking covers the SDK adapter and Host services. Repository gates cover metadata, documentation pairing, generated catalogs, dependency policy, and the invariant companion.

## Consequences

- The deployment needs outbound WeCom connectivity but no public callback listener.
- Web Workspace history remains the authoritative conversation record.
- Operators must preserve the identity key and configure explicit allowlists.
- Media messages, cards, horizontal scaling, and inbound replay are unsupported.
