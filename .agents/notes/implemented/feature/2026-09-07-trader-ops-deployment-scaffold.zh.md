# Agent Note: Trader Ops 空内容部署骨架

Status: implemented

[English](2026-09-07-trader-ops-deployment-scaffold.md) | 中文

## 问题

Trader Ops 部署拥有相互分离的 `knowledge/`、`skills/` 和 `policies/` 根目录，但其中还没有生产内容。开发仍然需要一种可复现的方式来启动 OpenViking、安装其 DSH 插件、注册部署本地的 skill（技能）根目录、验证组合后的 Profile，并在不提交凭据的前提下把同一套配置迁移到远程主机。

只有空目录布局并不能完成运行时接线。反过来，放入占位知识或虚假 skill 会使部署看起来比实际更完整。如果读者把描述性的 YAML 误认为已强制执行的 tool guard，Policy 示例尤其危险。

## 决策

在 `deployments/trader-ops/` 下添加由部署自有的空内容骨架：

- Docker Compose 以持久化存储运行 OpenViking，并只向回环地址发布端口。
- 纳入版本控制的 DSH patch 配置已安装的 OpenViking 运行时，并为 `deployments/trader-ops/skills` 添加专用文件系统 skill 提供方。
- 引导脚本固定 `@openviking/dsh-memory-plugin@0.3.0`，把它安装到选定 Profile，并通过 `--dump-config` 验证有效配置。
- 验证脚本检查 OpenViking 健康/就绪状态和 DSH 配置组合，并把知识文档或 skill 数量为零报告为合法状态。
- 环境模板不含真实秘密；远程部署使用权限为 `0600` 的环境文件，并把持久化状态放在 release 目录之外。
- 在真实服务和经过评审的工具 schema 存在以前，Trader Ops MCP 配置保持为默认关闭的示例。
- `tool-access.yaml` 已由私有实验包 `quant-tool-policy` 通过 `tools/pre-execute` 和单调 `ctx.tools.guard()` 兜底强制执行，未匹配工具默认拒绝。在可信身份和审批存储存在前，更广泛的风险与审批文档仍是设计约定。

OpenViking 记忆插件并不意味着自动把 Git 知识入库。后续工作必须为 `knowledge/` 同步到 OpenViking 定义经过评审的新增、更新和删除语义。

## 验证边界

该骨架验证包安装、patch 组合、服务健康和空内容发现。它不验证 VLM 或 embedding 模型提供方，因为这些凭据和模型选择由具体部署决定，并通过 `openviking-server init` 在 Git 之外创建。

它也不宣称业务授权已经生效。DSH 沙箱权限、OpenViking 身份验证和 Trader Ops 工具策略是三个独立边界；在允许不受信任或生产访问前，必须完成全部配置。

## 曾考虑的替代方案

- 提交带有猜测模型提供方的完整 `ov.conf` 模板。否决原因是所需 VLM、embedding 模型、端点和凭据因环境而异，看似可信的模板会鼓励无效或不安全的部署。
- 让 OpenViking 安装器在每台主机上选择最新版插件。骨架否决该方案，因为远程部署需要可复现的包解析；版本升级应经过显式评审。
- 添加占位 `SKILL.md` 和知识文档。否决原因是空发现是受支持状态，虚假内容会模糊基础设施就绪与业务就绪的边界。
- 把描述性 policy YAML 本身当作足够的控制。否决原因是没有执行 hook 的配置会制造虚假安全边界；当前骨架改为加载经过测试的 Harness 插件，并单独记录 MCP 服务承担最终授权责任。

## 后果

开发者可以在业务内容存在以前启动并验证集成，运维人员也获得了显式的远程文件系统布局和启动顺序。以后添加 skill 只需要一个有效的直接子目录 `SKILL.md`；添加知识仍然需要单独评审的入库路径。

Harness 侧的工具名/环境边界现已生效，并显式拒绝 OpenViking 永久遗忘。剩余未完成区域是真实的 Trader Ops MCP 服务，以及它的可信身份、资源/参数授权、持久审批与审计存储。在这一最终服务边界存在前，仍只允许可信开发者访问。

固定插件版本 `0.3.0` 提高了可复现性，但也带来一项有意的维护工作：任何 Harness 或 OpenViking 升级都必须重新检查 Node 要求、对等依赖（peer dependency）、有效配置以及健康/就绪行为。
