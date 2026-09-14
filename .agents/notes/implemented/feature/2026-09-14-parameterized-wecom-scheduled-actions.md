# Agent Note: Parameterized WeCom scheduled actions

Status: implemented

English | [中文](2026-09-14-parameterized-wecom-scheduled-actions.zh.md)

## Problem

The WeCom scheduler originally admitted only fully static deployment entries. Trader Ops could schedule `ps_check`, but a user request for another currently configured bssh_ops quick command or an exact custom shell either ran immediately or could not be represented as durable future execution. Enumerating every remote quick-command key in the Harness patch would duplicate mutable bssh_ops configuration, while placing arbitrary command text in the released scheduled-action record would change its durable format.

## Decision

A scheduled-action definition may declare one string `input` with an exact destination tool argument, a model-facing description, a positive UTF-8 byte limit, and an optional anchored regular expression. `scheduled_action_create` persists the exact admitted value and returns it in create and list projections. Static actions reject an input, and parameterized actions reject a missing, blank, NUL-containing, oversized, or expression-mismatched input.

Dynamic values live in the versioned `channel_wecom_scheduled_action_input` storage domain keyed by scheduled-action id. Creation writes the input before the action commit and removes it when that commit fails. Startup removes input records without a corresponding action. Dispatch fails closed when a parameterized record has no input, injects the value only into the configured top-level argument, and removes both records after notification. A recovered running action removes both records without replay. The released `channel_wecom_scheduled_action` record and its fingerprint for static definitions remain unchanged.

Trader Ops configures `quick_command` to place a safe key in bssh_ops `run_quick_command.command`, and `custom_shell` to place the exact command in `run_quick_command.custom_shell`. Both keep the target confined to `cf-sh-1` or `cf-sh-2`. The bssh_ops Skill obtains the current quick-command list before scheduling a key. For custom shell it checks syntax, shows the exact target, full command, expected impact, and rollback, and requires explicit user confirmation before scheduling. Secrets are forbidden in persisted input. Due-time execution still traverses Harness tool policy, and bssh_ops performs its own command validation, authorization, and audit.

The compatibility `ps_check` action remains static. Its existing fingerprint and pending records continue to work across this release.

## Security and recovery

Parameterized input increases the authority of a scheduled record, especially for arbitrary shell. The user-confirmation requirement is an Agent workflow rule rather than a cryptographic approval token; deployments needing independently enforceable approvals must add a durable approval capability before exposing `custom_shell`. The current deployment relies on WeCom admission allowlists, a confined noninteractive Agent preset, the exact target expression, Harness tool policy, MCP authentication, bssh_ops authorization and audit, and the prohibition on persisted credentials.

The scheduler commits running before dispatch and never repeats a recovered running operation. This preserves at-most-once dispatch across process loss but can report an uncertain outcome. The bssh_ops call normally returns a `run_id` before the remote command finishes, so the due notification reports trigger acceptance; final command output remains available through `get_run_status` and the provider audit record.

## Alternatives considered

**Declare every quick-command key as a static Harness action.** Rejected because it duplicates the live bssh_ops command registry and requires a Harness release whenever an operator changes that registry. The scheduling workflow instead lists current keys and bssh_ops rejects a key that is no longer valid at dispatch.

**Store input in the released scheduled-action record.** Rejected because adding a field would change an already released durable record format and complicate rollback. A separate versioned domain keeps the existing generation readable and makes an older release fail closed on unfamiliar parameterized action ids.

**Execute a Schedule reminder as a command.** Rejected because a due Schedule prompt is ordinary untrusted conversation content and does not own durable remote-operation dispatch. The dedicated scheduler persists structured authority and invokes only an operator-configured tool.

**Allow free-form tool names or argument objects.** Rejected because it would let model input select a new capability or overwrite deployment-owned arguments. Configuration fixes the tool, target argument, target expression, static arguments, and sole dynamic argument.

## Verification

Fake-clock tests cover exact quick-command and multiline shell persistence, due-time argument construction, UTF-8 and expression validation, action-write rollback, missing-input fail-closed behavior, orphan cleanup, pending restart recovery, recovered-running cleanup, policy denial, definition drift, cancellation, and scheduler quiescence. The Trader Ops recorded Session pins the parameterized management-tool schema. Deployment verification checks both dynamic action ids and their destination arguments.

## Consequences

- All current and future bssh_ops quick-command keys can be scheduled without changing the Harness patch, subject to list-time and dispatch-time provider validation.
- Exact user-provided shell commands can be scheduled after the required review and confirmation workflow.
- Dynamic inputs are durable and visible in scheduled-action management results, so they must never contain credentials or other secrets.
- Rollback to an older release does not reinterpret dynamic inputs; a parameterized action that becomes due there fails closed as an unknown definition and may be removed after its failure notification.
