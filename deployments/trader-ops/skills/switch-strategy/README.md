# switch-strategy Skill

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
description: 在完成风险检查和人工审批后切换产品策略，并验证最终状态。
whenToUse: 用户明确要求把指定产品切换到指定目标策略时。
user-invocable: true
disable-model-invocation: false
---

# Switch Strategy

1. 要求用户明确提供产品代码、目标策略和目标环境；任何一项缺失都停止。
2. 调用只读 Tool 查询当前策略、允许的目标策略、业务时段和冲突变更。
3. 根据检索到的已审核业务规则生成计划，但不执行写操作。
4. 提交包含产品、环境、旧策略、目标策略、风险级别和计划的审批请求。
5. 仅在 Tool Guard 返回有效审批后调用一次 `switch_product_strategy`。
6. 再次调用只读 Tool 验证绑定和运行状态，并输出审计 ID。
7. 任一步骤失败、状态漂移或审批过期时立即停止；不得绕过 Guard 或盲目重试。
```
