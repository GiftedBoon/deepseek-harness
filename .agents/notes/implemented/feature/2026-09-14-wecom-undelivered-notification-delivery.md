# Agent Note: Undelivered WeCom notifications survive until the conversation returns

Status: implemented

English | [中文](2026-09-14-wecom-undelivered-notification-delivery.zh.md)

## Problem

A scheduled action reports its result through an active Markdown send at the moment the action falls due, and the operator need not be present then. The provider can refuse that send while the conversation is idle.

Before this change, a refused item was retried on the fixed interval and **deleted once it reached `maxOutboxAttempts`** — ten attempts thirty seconds apart at the defaults, so roughly five minutes. An inbound message triggered no delivery attempt at all: the only triggers were channel start, reconnection, and the interval timer. A notification that fell due while nobody was looking was therefore deleted after five minutes, and one that stayed undeliverable appeared only if the operator happened to write in while a retry was still pending.

Two defects hid the cause. The SDK rejects a refused reply with the acknowledgement frame, whose `errcode` and `errmsg` are the only statement of why the provider refused; the runtime rendered that frame through `errorChain`, which stringifies a non-`Error` object, so the journal recorded `[object Object]`. And a failed attempt produced no log line unless it was the last one, so a five-minute run of refusals was invisible.

## Decision

`drainOutbox` separates periodic retry from presence-driven delivery, and nothing is deleted before `outboxRetentionMs`.

| Trigger | Scope | Retries exhausted items |
|---|---|---|
| Channel start, SDK authentication | every item | yes |
| Interval timer (`outboxRetryIntervalMs`) | every item | no |
| Item enqueued | that target only | yes |
| Inbound message admitted for a conversation | that conversation's target only | yes |

An item that reaches `maxOutboxAttempts` stops being retried by the timer and waits for its conversation to write in, which drains it immediately. Items are removed only by successful delivery or by reaching `outboxRetentionMs`, whose default of seven days bounds growth. The periodic pass also prunes expired items.

Each failed attempt logs its attempt count and the provider diagnostic. The transport adapter converts a rejected SDK frame into an `Error` whose message names `errcode` and `errmsg`, so the reason survives `errorChain`. The target and the content never reach the log, because they carry provider identity and message text.

A scheduled action whose conversation route is no longer stored logs a warning instead of skipping the notification silently.

## Delivery triggers

Draining is serialized on one promise chain, so a drain triggered by an inbound message cannot interleave with the timer's pass. The inbound drain is not awaited by the Agent turn: the turn's answer travels the passive stream, and the pending notification is an independent active send. A failing active send therefore delays the notification, never the reply.

Matched by provider target rather than by conversation key, because the outbox record stores the send target and not the conversation. An inbound message for one conversation leaves every other conversation's items for their own next message.

## Alternatives considered

**Keep deleting at the attempt limit.** This is the behavior that produced the defect: the limit bounds retry effort, not usefulness, and a notification deleted five minutes after it fell due cannot be recovered. The retention bound moves that decision to an operator-controlled age.

**Retry every item on the timer forever.** It bounds nothing and keeps hammering a provider that has already refused the send. Separating periodic retry from presence-driven delivery keeps the effort bounded while preserving the item.

**Attach pending notifications to the passive reply.** The passive reply answers the message that just arrived and shares one UTF-8 byte budget with it, so merging an unrelated notification would conflate two deliveries and let one truncate the other. The active send also keeps the notification independently auditable.

**Log the target and the content to explain a failure.** Rejected: the package never logs accepted provider ids or message text. The provider diagnostic is sufficient to distinguish a rate limit from a malformed request from a refused conversation.

**Add a state field to the outbox record.** The record already carries `attempts`, `createdAt`, and `updatedAt`, and the attempt count against `maxOutboxAttempts` identifies an exhausted item. A new field would require a `channel_wecom` domain version and migration for information the existing values already express.

## Consequences

Bought: a notification that falls due while the operator is away is delivered when that conversation next writes in, instead of being lost five minutes later; the journal states why a send failed; and an undelivered item has an explicit, configurable retention instead of an implicit one derived from retry arithmetic.

Cost: an item can outlive its usefulness for up to `outboxRetentionMs`; a conversation with pending items performs one extra active send attempt when it next writes in, which the SDK bounds by its five-second acknowledgement timeout; and `maxOutboxAttempts` no longer bounds retention, so `outboxRetentionMs` is the value that decides when an undelivered notification is given up.

The channel tests pin the four trigger rows, the retention pruning, the per-attempt diagnostic, and the single-target inbound scope; the transport tests pin the `errcode`/`errmsg` rendering.
