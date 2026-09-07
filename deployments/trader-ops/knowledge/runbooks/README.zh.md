# Runbooks：可检索操作手册

[English](README.md) | 中文

本目录保存经审核的排障和恢复手册。OpenViking 可检索其中相关章节，帮助 Agent 理解检查项、故障原因和验证标准；需要稳定触发并完整执行的流程仍应封装成 Skill。

## 应该放在这里

- 故障症状、影响范围、诊断顺序和恢复验证方法。
- 人工处置说明、升级联系人角色和回滚原则。
- 事故经验经人工审核后形成的正式操作手册。
- 与业务规则、系统说明和相关 Skill 的链接。

## 不应该放在这里

- 仅靠检索片段就执行的生产变更指令。
- 权限和审批规则的唯一来源；它们属于 `../../policies/`。
- 未验证的聊天记录、临时猜测和事故原始日志。
- 密钥或可绕过 Tool Guard 的命令。

## 示例：`switch-strategy.md`

```markdown
---
type: runbook
domain: trading
owner: trading-operations
status: approved
risk_level: high
tags: [strategy, change, rollback]
updated_at: 2026-09-07
---

# Strategy switch runbook

## Applicable scenario

The operator has confirmed that a product must move from its current strategy to an approved target strategy.

## Manual checks

1. Confirm the product, environment, and target strategy.
2. Confirm that no conflicting change is active.
3. Obtain production-change approval.
4. Query the binding and process status after execution.

## Failure handling

Stop further changes, retain the tool-call and approval audit records, and escalate through the duty process. Do not attempt a second write without a reviewed rollback procedure.

## Automation entry point

The `switch-strategy` skill loads and orchestrates the complete automated procedure.
```
