# Runbooks：可检索操作手册

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

# 策略切换 Runbook

## 适用场景

已确认需要把产品从当前策略切换到已获准的目标策略。

## 人工检查

1. 核对产品、环境和目标策略。
2. 确认当前无冲突变更。
3. 获取生产变更审批。
4. 执行后重新查询绑定与进程状态。

## 失败处理

停止继续变更，保留 tool call 与审批审计记录，并按值班流程升级。不得在缺少已审核回滚方案时自行尝试第二次写入。

## 自动化入口

完整自动化流程由 `switch-strategy` Skill 加载和编排。
```
