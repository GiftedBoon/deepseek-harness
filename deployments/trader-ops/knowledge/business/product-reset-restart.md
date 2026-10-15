---
type: business-rule
domain: trading
owner: bwpan
status: approved
risk_level: high
tags: [colo, strategy, reset, restart]
updated_at: "2026-10-15"
---

# 产品重置与重启

本文定义产品重启与产品重置的含义和先后顺序。执行步骤、工具和确认要求见 Skill `product-restart-reset`，本文不重复。

## 规则

- colo 上的运维脚本位于登录用户的 `~/trade` 目录，执行前先进入该目录。
- 开启和停止策略有两种范围：整台 colo 机器，或单个产品。整机操作影响该机器上的全部产品。
- **产品重启**：停止该产品的 alpha 策略，执行该产品的仓位查询，再启动该产品的 alpha 策略。仓位查询是必要环节，脚本运行不报错即视为成功。
- **产品重置**：停止该产品的 alpha 策略，按产品名查出对应的 alpha_id，用 alpha_id 对 memdb 中该策略执行 reset，再重启该产品。查不到 alpha_id 时不执行 reset。
- 重置与重启的区别：重置多出 memdb reset，该操作不可逆；重启不执行它。

## 适用范围

### 适用条件

- 需要让某个产品的策略重新开始运行，或需要清除其策略在 memdb 中的状态。

### 例外

- 无。

## 权威数据源

- 产品名到 colo 的归属：以当次 MCP 查询结果为准。
- alpha_id：以 colo 上 `trading-accounts.cfg` 的当次查询结果为准，不在知识库中记录。
