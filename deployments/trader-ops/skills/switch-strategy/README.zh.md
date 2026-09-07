# switch-strategy Skill

[English](README.md) | 中文

本目录承载“切换产品策略”的完整 Skill bundle。这是高风险写操作：Skill 负责组织检查、计划、审批、执行和验证，但最终权限必须由 Policy/Hook/Tool Guard 强制执行，不能只依赖提示词。

## 应该放在这里

- 产品和目标策略确认、前置检查、执行计划和后置验证。
- 对高风险 Policy、人工审批和审计字段的明确要求。
- Tool 返回失败、审批拒绝或状态变化时的停止条件。
- 已审核的回滚引用；如无安全回滚路径，应升级人工处理。

## 不应该放在这里

- 审批人的硬编码身份或长期有效的审批令牌。
- 绕过 Policy、直接执行 SSH 命令或连续盲目重试的指令。
- 业务规则的唯一副本；权威规则放在 `../../knowledge/business/`。
- `switch_product_strategy` Tool 的内部实现。

## `SKILL.md` 示例

```markdown
---
name: switch-strategy
description: Switch a product strategy after risk checks and human approval, then verify the final state.
whenToUse: Use when the user explicitly asks to switch a specified product to a specified target strategy.
user-invocable: true
disable-model-invocation: false
---

# Switch Strategy

1. Require the product code, target strategy, and target environment; stop when any value is missing.
2. Use read-only tools to query the current strategy, allowed targets, business window, and conflicting changes.
3. Build a plan from retrieved, reviewed business rules, but do not perform a write.
4. Submit an approval request with product, environment, old strategy, target strategy, risk level, and plan.
5. Call `switch_product_strategy` exactly once and only after Tool Guard returns a valid approval.
6. Call read-only tools again to verify the binding and runtime state, then report the audit ID.
7. Stop immediately on any failure, state drift, or expired approval; never bypass the Guard or retry blindly.
```
