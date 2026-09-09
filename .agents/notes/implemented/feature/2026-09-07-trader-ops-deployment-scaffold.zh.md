# Agent Note: Trader Ops 空内容部署骨架

Status: implemented

[English](2026-09-07-trader-ops-deployment-scaffold.md) | 中文

## 问题

Trader Ops 部署拥有相互分离的 `knowledge/`、`skills/` 和 `policies/` 根目录，但其中还没有生产内容。开发仍然需要一种可复现的方式来启动 OpenViking、安装其 DSH 插件、注册部署本地的 skill（技能）根目录、验证组合后的 Profile，并在不提交凭据的前提下把同一套配置迁移到远程主机。

只有空目录布局并不能完成运行时接线。反过来，放入占位知识或虚假 skill 会使部署看起来比实际更完整。如果读者把描述性的 YAML 误认为已强制执行的 tool guard，Policy 示例尤其危险。

## 决策

在 `deployments/trader-ops/` 下添加由部署自有的空内容骨架：

- Docker Compose 以持久化存储运行 OpenViking，并只向回环地址发布端口。
- macOS MVP 在宿主机原生运行 Ollama，以便 embedding 和 query planner 使用 Metal 加速。OpenViking 容器通过 `host.docker.internal` 访问它；纳入版本控制的本地配置使用环境变量占位符，不写入凭据。
- 一个可选 DSH patch 把 AIHubMix 端点声明为 OpenAI-compatible `llm-pi-ai` 路由。`TRADER_OPS_LLM_PROVIDER` 选择该路由；省略 patch 时，仍使用 Profile 的常规模型。OpenViking 使用同一远程路由进行语义提取。
- OpenViking 账户管理使用 root key，Harness 和普通数据命令则使用独立的租户 user key。
- 纳入版本控制的 DSH patch 配置已安装的 OpenViking 运行时，并为 `deployments/trader-ops/skills` 添加专用文件系统 skill 提供方。
- 引导脚本固定 `@openviking/dsh-memory-plugin@0.3.0`，把它安装到选定 Profile，并通过 `--dump-config` 验证有效配置。
- 验证脚本检查 OpenViking 健康/就绪状态和 DSH 配置组合，并把非空知识文档或 skill 数量为零报告为合法状态。空白和只含空白字符的 Markdown 不计进入库候选数量。
- 环境模板不含真实秘密；远程部署使用权限为 `0600` 的环境文件，并把持久化状态放在 release 目录之外。
- Debian MVP 使用三个显式阶段：带下载校验的 root 主机引导、非 root 的精确 commit 发布构建，以及从终端隐藏提示读取已轮换中转 key 的 root 运行时配置。
- 发布时配置与 systemd 直接调用已构建的 DSH CLI。部署 overlay 从该 release 解析私有策略插件，外部 Profile 只拥有树外依赖。由 pnpm 支持的源码启动器仅用于可写的开发检出，不能在不可变发布中调整依赖。
- 运行时配置在加载 Trader Ops 插件的情况下冒烟测试远程模型，再要求 Web 成功响应或返回预期的身份验证挑战，并保持 systemd 重启次数稳定。该单元会限制反复启动失败的重试速率。
- Linux 原生 Ollama 只监听 Docker bridge gateway，OpenViking 与 Harness 保持只监听回环地址。一个可选 systemd socket 会绑定一个属于本机的 IPv4 地址并代理到 Harness；`--trusted-host` 允许该 authority 通过浏览器 Host/Origin 围栏，而不启用 CLI 禁止的通配绑定。配置器拒绝通配和不属于本机的代理地址，MVP 不添加公网反向代理。
- 在真实服务和经过评审的工具 schema 存在以前，Trader Ops MCP 配置保持为默认关闭的示例。
- `tool-access.yaml` 已由私有实验包 `quant-tool-policy` 通过 `tools/pre-execute` 和单调 `ctx.tools.guard()` 兜底强制执行，未匹配工具默认拒绝。在可信身份和审批存储存在前，更广泛的风险与审批文档仍是设计约定。

OpenViking 记忆插件并不意味着自动把 Git 知识入库。后续工作必须为 `knowledge/` 同步到 OpenViking 定义经过评审的新增、更新和删除语义。

## 验证边界

该骨架验证包安装、patch 组合、服务健康、空内容发现、基于本地 Ollama 的 embedding 和 query planner、远程语义提取，以及可选的 Harness 端到端回合。远程凭据仍由具体部署决定，并保留在 Git 之外。

它也不宣称业务授权已经生效。DSH 沙箱权限、OpenViking 身份验证和 Trader Ops 工具策略是三个独立边界；在允许不受信任或生产访问前，必须完成全部配置。

## 曾考虑的替代方案

- 提交带有猜测模型提供方的完整 `ov.conf` 模板。否决原因是所需 VLM、embedding 模型、端点和凭据因环境而异，看似可信的模板会鼓励无效或不安全的部署。
- 在 macOS 的 Docker Desktop 中运行 Ollama。否决原因是这条路径无法使用 Apple Metal 加速，还会在容器环境中复制模型状态；原生 Ollama 让推理保持在本机，同时允许容器随时替换。
- 把直接 `deepseek-official` 适配器指向第三方中转站。否决原因是该路由自有 DeepSeek 专用 wire 行为；现有 `llm-pi-ai` 声明式提供方路径才是 OpenAI-compatible 服务的受支持抽象。
- 让 OpenViking 安装器在每台主机上选择最新版插件。骨架否决该方案，因为远程部署需要可复现的包解析；版本升级应经过显式评审。
- 添加占位 `SKILL.md` 和知识文档。否决原因是空发现是受支持状态，虚假内容会模糊基础设施就绪与业务就绪的边界。
- 把描述性 policy YAML 本身当作足够的控制。否决原因是没有执行 hook 的配置会制造虚假安全边界；当前骨架改为加载经过测试的 Harness 插件，并单独记录 MCP 服务承担最终授权责任。

## 后果

开发者可以在业务内容存在以前启动并验证集成，运维人员也获得了显式的远程文件系统布局和启动顺序。以后添加 skill 只需要一个有效的直接子目录 `SKILL.md`；添加知识仍然需要单独评审的入库路径。

即使文件为空，OpenViking 也可能根据文件名派生语义元数据。因此部署验证不会统计空白或只含空白字符的 Markdown，入库流程也必须拒绝这类文件，避免生成误导性的可检索资源。

声明 65,536 tokens 的上下文可以避免当前 Harness 系统提示和工具目录立即触发压缩；更换远程模型时，运维人员必须重新验证容量、延迟和工具行为。

远程中转会把所有模型可见的提示词、检索记忆、工具描述和用户消息发送到受控主机之外。使用该路由处理受限数据前，运维人员必须批准其端点归属、模型路由、保留策略和数据处理条款。

主机引导固定 Node、pnpm、Ollama、它的两个模型 id 与 OpenViking 镜像 digest。Docker Engine 跟随 Docker 的签名 Debian apt 软件源；因此升级时既要评审解析出的 Docker 软件包版本，也要评审显式固定的产物。

Harness 侧的工具名/环境边界已经生效，并显式拒绝 OpenViking 永久遗忘。剩余未完成区域是真实的 Trader Ops MCP 服务，以及它的可信身份、资源/参数授权、持久审批与审计存储。内网代理通过明文 HTTP 传输 bearer URL token 与 session cookie，因此在最终服务边界和 TLS 终止器存在前，其网络与用户都必须可信。

固定插件版本 `0.3.0` 提高了可复现性，但也带来一项有意的维护工作：任何 Harness 或 OpenViking 升级都必须重新检查 Node 要求、对等依赖（peer dependency）、有效配置以及健康/就绪行为。
