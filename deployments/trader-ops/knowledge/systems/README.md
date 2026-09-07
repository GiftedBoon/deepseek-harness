# Systems：系统与依赖说明

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

Strategy Control 是产品策略绑定关系的权威服务。

## Agent 接入

| Tool | 行为 | 数据新鲜度 |
|---|---|---|
| `get_product_strategy` | 只读查询当前绑定 | 实时 |
| `switch_product_strategy` | 修改生产绑定 | 实时，高风险 |

## 约束

写入工具必须经过 `policies` 的身份、风险和审批检查。Agent 不得根据本文中的示例值推断生产状态。
```
