---
name: product-restart-reset
description: 重启或重置指定产品的 alpha 策略：按固定顺序停止策略、执行仓位查询、（重置时）执行不可逆的 memdb reset、再启动策略。用户要求重启产品、重置产品，或对多个产品批量执行时使用；整机启停和整机仓位查询用 bssh-ops 的快捷命令。
whenToUse: Use when the user asks to restart or reset one or more products' alpha strategy.
user-invocable: true
---

# 产品重启与重置

本 Skill 只编排流程，通道规则、确认要求和失败处理遵守 [bssh-ops](../bssh-ops/SKILL.md)。重启与重置的业务含义见知识库的“产品重置与重启”。只立即执行；用户要求在未来时间执行时，说明目前不支持，不用 `scheduled_action_create` 或保存 shell 代替。

所有步骤都用产品动作：`mcp__bssh-ops-remote__preview_product_action` 预览，`mcp__bssh-ops-remote__execute_product_action` 执行，`mcp__bssh-ops-remote__get_run_status` 按 `run_id` 查每台 colo 的结果。动作名和命令以本次 `mcp__bssh-ops-remote__list_product_actions` 为准。产品名按动作 label 的要求写成小写，例如 `hj1`。不要用快捷命令 `start`/`stop`，也不要用改参通道的 `kill`/`start`。

## 流程

重启：

1. `stop product alpha`，在该产品的全部 colo 上执行。
2. 仓位查询，按下文规则选择动作和 colo。
3. `start product alpha`，在该产品的全部 colo 上执行。

重置：

1. `stop product alpha`，在该产品的全部 colo 上执行。
2. `reset product`，在该产品的全部 colo 上执行。该动作在 colo 上按产品名查 alpha_id，查不到就不执行 reset；memdb reset 不可逆。
3. `start product alpha`，在该产品的全部 colo 上执行。

重置不含仓位查询。

## 仓位查询

动作是 `sh product position query` 和 `sz product position query`。按 `preview_product_action` 返回的 colo 名决定每台 colo 用哪一个：

- 名字含 `-sz-` 或 `-dg-`：`sz product position query`。
- 名字含 `-sh-`：`sh product position query`。
- 名字恰为 `cfipasz1`：`sz product position query`；恰为 `cfipash1`：`sh product position query`。
- 其他名字：停止并向用户说明，不要猜测。

返回 1 台 colo 的产品，只在这台 colo 上执行它对应的动作。返回 2 台 colo 的双中心产品，`execute_product_action` 的 `confirmed_colos` 每次只填一台：先在 sh colo 上执行 sh 动作，结果成功后再在 sz colo 上执行 sz 动作。两台 colo 不是一个 sh 加一个 sz 时停止并向用户说明。仓位查询脚本运行不报错即视为成功。

## 确认与执行

1. 确认产品名；缺失时提问，不能猜测。多个产品时逐个解析，不合并。
2. 对流程里的每个动作调用 `preview_product_action`；任一 `syntax_ok` 为 false 时停止。
3. 一次向用户展示完整计划：每个产品的流程、每一步的动作、colo 和 `shell_command`。重置明确写出“memdb reset 不可逆”。取得明确确认后才开始执行。
4. 严格按流程顺序执行。每一步把对应 preview 的 `confirmed_colos` 和 `confirmed_shell` 原样传给 `execute_product_action`，再用 `get_run_status` 确认每台 colo 的结果，全部成功才进入下一步。

## 失败与批量

任一步失败、结果缺失或状态不确定时，停止该产品的后续步骤，不自动重试，不跳到下一步。报告已完成的步骤、失败的步骤和 `run_id`，并明确该产品当前状态，例如“策略已停止，尚未启动”。批量时各产品相互独立：一个产品停止不影响其他产品继续；最后逐产品汇总结果。

回复不展示密钥，也不复制输出中的敏感值。
