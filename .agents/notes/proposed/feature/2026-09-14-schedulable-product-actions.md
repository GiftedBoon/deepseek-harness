# Agent Note: Schedulable product actions for the Trader Ops WeCom channel

Status: proposed

English | [中文](2026-09-14-schedulable-product-actions.zh.md)

## Problem

The Trader Ops WeCom channel schedules durable actions from a closed list of deployment entries, and every current entry dispatches `mcp__bssh-ops-remote__run_quick_command`: `ps_check`, `quick_command`, and `custom_shell`. A request that names a product-level operation at a future time — "open HJ1's strategy at 17:32, kill it at 17:34" — therefore cannot be scheduled as the operation the operator named. The model's only available path is to schedule one raw `custom_shell` per colo using the command text an earlier `preview_product_action` returned.

That fallback changes both the meaning and the protection of the record:

- **The product identity does not survive.** The record's `target` holds a colo, so the due-time notification and the bssh_ops audit entry state that a shell ran on two machines, not that HJ1 was killed.
- **Product ownership is frozen at preview time.** `preview_product_action` resolves a product's colos from current ownership, and a scheduled record persists that derived result. Ownership can change before dispatch while the record keeps targeting the machines resolved earlier. The scheduled-action fingerprint protects the Harness-side action definition, not the target's continued validity.
- **The command loses its reviewed-action binding.** `execute_product_action` renders its command from a reviewed product action, while `custom_shell` carries an opaque string whose only bound is a UTF-8 byte count.

The scheduling mechanism cannot express the product operation either: one scheduled action carries exactly one target, optionally wrapped as a one-element array, plus at most one model-supplied string. A dual-center product needs two colos plus a command. This proposal reuses the `input` mechanism recorded in [parameterized WeCom scheduled actions](../../implemented/feature/2026-09-14-parameterized-wecom-scheduled-actions.md).

## Proposal

Register one scheduled action that carries the two values the operator states: the product and a closed action key.

### Server entry point

bssh_ops gains a call that resolves the product when the call arrives, mirroring what `preview_product_action` already resolves:

| Aspect | Requirement |
|---|---|
| Input | `product`, the exact product name, and `action`, a key from the reviewed action set |
| Key source | Ids returned by `list_product_actions`, or the reviewed change-cfg command whitelist such as `kill`, `start`, `open_t0`, and `close_t0` |
| Behavior | Resolve the product's current colos, render the reviewed command, enforce the single/dual-center invariant, authorize, execute per colo, and write one audit entry naming the product and the action key |
| Output | A `run_id` with per-colo results, matching the other write tools |

The key set must be closed and enumerable, so the model selects a key instead of constructing a command.

### Harness-side registration

One entry in [`trader-ops-wecom.patch.yml`](../../../../deployments/trader-ops/config/dsh/trader-ops-wecom.patch.yml):

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

No package change is required: the existing `target` and `input` slots carry both values, the same shape `quick_command` uses for a colo and a quick-command key. Two deployment-owned follow-ups belong with it: classify the new tool in [`tool-access.yaml`](../../../../deployments/trader-ops/policies/tool-access.yaml), and add the product scheduling flow to the [`bssh-ops` Skill](../../../../deployments/trader-ops/skills/bssh-ops/SKILL.md).

### Dispatch-time authorization

Scheduled dispatch already re-resolves the action definition and re-runs the tool policy. This proposal puts product resolution on that same path, so ownership, the action definition, and authorization are all evaluated when the effect happens rather than when it was scheduled.

## Alternatives considered

**Add a multi-element target format to `packages/channel/channel-wecom`.** Extending `targetArgumentFormat` with an array form would let one record carry `confirmed_colos` for a dual-center product plus `confirmed_shell`, so `execute_product_action` could be registered directly. It loses because it persists a derived value where the operator stated an identity: the product name has no slot, ownership is frozen at preview time, and the audit entry reports colos and a shell. It also widens the generic scheduling mechanism for a use case that product semantics define.

**Register `execute_product_action` with one record per colo.** This is expressible today, because `singleton-array` wraps a single colo and `input` carries `confirmed_shell`. It keeps the reviewed-action binding, but it splits one operator-visible operation into two independent records, each of which claims a single colo, and it still freezes the ownership resolved at preview time. Partial failure then leaves the product in a half-applied state that no record describes.

**Keep the `custom_shell`-per-colo fallback.** This is the behavior that prompted the note. It is rejected because it discards the product identity and the reviewed-action binding, and because it leaves target validity checked only at preview time.

**Carry a structured `rules` array in the scheduled record.** Scheduling an arbitrary `preview_change_cfg_paras` rule set would need structured input rather than one string. It stays out of scope: the reviewed-key form covers the routine strategy start and stop requests, and an arbitrary rule set has no reviewed key to enumerate.

## Acceptance criteria

- `scheduled_action_create` offers a product action whose `action` parameter enumerates only server-provided keys.
- A record created for product HJ1 and dispatched after an ownership change acts on HJ1's current colos, and its audit entry names the product and the action key.
- An unknown key fails closed at creation; a key invalidated before dispatch fails closed at dispatch and reports the failure to the conversation.
- The registration adds no package dependency and no new configuration field to `packages/channel/channel-wecom`.

## Risks

- **The key set must stay closed and reviewed.** A server that accepts arbitrary keys reintroduces the opaque-command property this proposal removes.
- **Dispatch-time resolution can act on a different colo set than the operator previewed.** That is the intended trade: the product identity is the invariant, not the machine list. The due-time notification must state the resolved colos so a difference is visible.
- **The contract lives outside this repository.** Nothing becomes schedulable by product until the bssh_ops service ships the entry point, and this note records the contract only.
