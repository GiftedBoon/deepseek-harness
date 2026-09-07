# Systems：系统与依赖说明

[English](README.md) | 中文

本目录记录系统职责、组件关系、数据流、接口语义和可观测性入口。OpenViking 检索这些内容，为 Agent 定位正确系统和工具提供背景。

## 应该放在这里

- 系统边界、负责人、上下游依赖和环境差异。
- MCP tool 对应的后端服务及其只读/写入语义。
- 数据库表、API 字段和监控指标的解释。
- 脱敏后的主机角色、服务名称和故障域说明。

## 不应该放在这里

- 密码、Token、私钥、完整生产连接串或其他秘密。
- 可直接执行的危险命令。
- 业务概念定义；放在 `../business/`。
- 具体事件的处置流程；放在 `../runbooks/`。

## 示例：`strategy-control.md`

```markdown
---
type: system
system: strategy-control
owner: trading-platform
status: approved
tags: [strategy, mcp, production]
updated_at: 2026-09-07
---

# Strategy Control

Strategy Control is the authoritative service for product-strategy bindings.

## Agent integration

| Tool | Behaviour | Data freshness |
|---|---|---|
| `get_product_strategy` | Read the current binding | Live |
| `switch_product_strategy` | Change the production binding | Live, high risk |

## Constraints

Write tools must pass the identity, risk, and approval checks in `policies`. The agent must not infer production state from example values in this document.
```
