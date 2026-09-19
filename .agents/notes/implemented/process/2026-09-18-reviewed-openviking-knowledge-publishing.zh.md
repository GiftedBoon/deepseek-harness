# Agent Note: 受评审的 OpenViking 知识发布

Status: implemented

[English](2026-09-18-reviewed-openviking-knowledge-publishing.md) | 中文

## 问题

Trader Ops 在 Git 中保存持久业务知识，而 OpenViking recall 只能读取已经提交并建立索引的 resource。通过 Studio 或 Agent 工具手工复制文件会使发布状态难以评审，无法可靠地区分草稿和已批准内容，还可能造成 Git 与检索结果不一致。自动删除尤其危险，因为删除 OpenViking resource 还可能清理引用它的 memory。

## 决策

`deployments/trader-ops/scripts/sync-knowledge.mjs` 是从三个知识源目录到 `viking://resources/trader-ops/knowledge/` 的运维受控发布器。默认模式只执行本地计划。`--apply` 要求持久状态路径和 `OPENVIKING_API_KEY`，通过 OpenViking 临时上传 API 上传每个变化的 Markdown 文件，刷新准确且稳定的 URI，同时提交原始 tag 以及带命名空间的 domain、type 和 owner tag，等待语义与向量处理完成，然后原子记录该文件的 checkpoint。

发布器接纳目录 README 之外、路径为小写的非空 Markdown。草稿保留在 Git 中但不会发布。已批准条目必须包含类型、领域、负责人、日期、非空标签和不含 TODO 的完整正文。SHA-256 内容 hash 用于区分新增、更新和未变化动作。外部状态不包含凭据或文档正文，排他锁会阻止针对同一状态文件的并发 apply。

不在已批准文档集合中的源路径会被报告为 stale，但仍保留在 OpenViking。发布器没有删除模式。后续删除能力需要独立评审的流程，预览准确 URI，并考虑 memory 引用清理。

## 考虑过的替代方案

**让 Agent 调用 `mcp__openviking__add_resource`。** 拒绝，因为发布属于部署职责，模型编写的工具参数不能作为文档审批、目标身份或仓库完整性的可信来源。生产工具策略继续不向 Agent 开放这条写入路径。

**把完整 knowledge 目录发布成一个 resource。** 拒绝，因为草稿和目录说明会进入检索，一个无效文档可能掩盖受影响来源，并且会丢失逐文档审批与失败证据。

**对 Harness 仓库使用 OpenViking Assets。** 拒绝，因为在当前源布局中，Assets 协议把整个 Git 仓库视为 asset，而 Trader Ops 只发布一个经过评审的子树，并需要逐文件审批。Assets 也会保留 orphan resource，因此无法消除发布器必须显式呈现的主要生命周期决策。

**在普通 apply 中删除 stale resource。** 拒绝，因为源文件移除或审批降级不足以授权远端破坏性操作。保留并持续报告 stale 条目可以暴露差异，同时不危及知识或相关 memory。

## 验证

聚焦测试覆盖已批准、草稿和空文件发现、必填元数据拒绝、确定性的新增、更新、未变化和 stale 计划、准确的认证上传与入库请求、原子状态持久化，以及 apply 对状态路径的要求。部署校验会运行只读计划，因此无效的已批准知识会在不接触 OpenViking 的情况下阻止发布。

## 结果

- Git 继续作为经过评审的业务知识源，只有已批准条目才有资格进入检索。
- 发布可以重复执行并且是增量的，但有意由运维人员触发，而不是定时执行。
- 远端部分成功会逐文件记录 checkpoint；后续运行会针对稳定 URI 安全重试剩余变更。
- stale resource 在实现并执行独立删除决策前可能继续被检索。
