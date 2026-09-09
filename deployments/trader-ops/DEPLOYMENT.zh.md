# 远程部署步骤

[English](DEPLOYMENT.md) | 中文

本运行手册把 Trader Ops MVP 部署到一台 Debian 12 `amd64` 主机。Harness、OpenViking 和宿主机原生 Ollama 都保留在该主机，用户只通过 SSH 隧道访问 Harness。本 MVP 明确不包含反向代理和公网监听。

## 已验证目标

第一台目标机器是 SSH 主机 `dsh-server`。预检确认它使用 Debian 12，具有四个 CPU 核心、7.7 GiB 内存及 swap、34 GB 可用磁盘、systemd、Python 3.11，并可访问 GitHub、npm、GHCR、Node.js、Ollama、Docker 和 AIHubMix。引导前没有 Docker、Node.js、pnpm、Git 与 curl。1933、3180 和 11434 端口均未占用。

纳入版本控制的引导脚本固定 Node.js 24.20.0、pnpm 11.7.0、Ollama 0.33.3、两个本地 Ollama 模型，以及已在开发 Mac 验证的多平台 OpenViking 镜像 digest。Docker Engine 与 Compose 来自 Docker 的签名 Debian 软件源。

## 文件系统与网络布局

```text
/opt/deepseek-harness/releases/<git-commit>/  # 不可变源码与构建
/opt/deepseek-harness/current                 # 当前发布的符号链接
/etc/deepseek-harness/trader-ops.env          # root:root 0600，密钥与环境
/var/lib/deepseek-harness/                    # dsh Profile 与运行状态
/var/lib/openviking/                          # root 所有的 OpenViking 配置与数据
/usr/share/ollama/                            # Ollama 服务 home 与模型数据
/srv/dsh-workspace/                           # Agent 可访问的工作目录
```

Harness 监听 `127.0.0.1:3180`，OpenViking 发布到 `127.0.0.1:1933`。原生 Ollama 只监听 Docker bridge gateway 的 11434 端口；`host.docker.internal` 把 OpenViking 容器映射到该地址。没有应用端口绑定到宿主机的局域网地址。

## 1. 引导 Debian 主机

把 `scripts/bootstrap-debian-host.sh` 复制到远程运维用户的 home，评审脚本后在交互式 SSH 终端中运行：

```bash
ssh -t dsh-server \
  'sudo env TRADER_OPS_DEPLOY_OPERATOR="$USER" bash /home/boon/trader-ops-bootstrap-debian.sh'
```

脚本会验证 Debian 12/amd64，拒绝冲突的容器软件包，从签名 apt 软件源安装 Docker，校验 Node 与 Ollama 下载，创建 `dsh` 和 `ollama` 服务用户，配置持久化目录，把 Ollama 限制到 Docker bridge 地址，并且只拉取以下模型：

```text
qwen3-embedding:0.6b
guoxuter/ov_intent_analysis_sft:v7_q8
```

1.3 GB 的 Ollama 运行时和模型下载使本阶段耗时最长。网络失败后可以安全重试；如果脚本报告安装不完整或软件冲突，应先检查它指出的精确路径，不要自动修改或删除内容。

## 2. 构建并激活不可变发布

使用完整且已评审的 commit SHA，以非 root 部署运维用户运行发布安装器：

```bash
ssh dsh-server \
  '/home/boon/trader-ops-install-release.sh <40-character-git-commit>'
```

安装器只获取该 commit，运行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，记录构建标记，再原子移动 `/opt/deepseek-harness/current`。它不会重启任何服务。已有目录缺少构建标记时会被视为未完成发布，需要人工检查而不是自动删除。

## 3. 安装密钥并启动运行时

先轮换任何曾粘贴到聊天或日志中的 API key。然后在交互式 SSH 终端中运行运行时配置器：

```bash
ssh -t dsh-server \
  'sudo bash /opt/deepseek-harness/current/deployments/trader-ops/scripts/configure-debian-runtime.sh'
```

在隐藏提示处输入已轮换的 AIHubMix key。脚本默认使用 `https://api.inferera.com/v1` 和 `deepseek-v4-flash-0731`，生成独立的 OpenViking root key，写入权限为 `0600` 的环境文件，启动 OpenViking，创建 `trader-ops/remote-admin` 租户身份，保存权限更窄的 user key，安装固定版本的 DSH 插件，验证有效 Profile 和一次真实远程模型回合，最后启动 `dsh-trader-ops.service`。

配置器可继续执行：环境文件存在后会复用它，不会再次询问或覆盖凭据。如果 OpenViking account 已存在但租户 key 仍为空，它会只重新生成该 admin key 并保存新值。Harness 永远不会取得 root key。

## 4. 验证并连接

在服务器上确认只存在回环或 Docker bridge 监听，并确认两个服务都处于 active：

```bash
sudo systemctl --no-pager --full status docker ollama dsh-trader-ops
sudo ss -ltnp | grep -E ':(1933|3180|11434)[[:space:]]'
sudo docker compose --env-file /etc/deepseek-harness/trader-ops.env \
  -f /opt/deepseek-harness/current/deployments/trader-ops/config/openviking/docker-compose.yml ps
sudo docker exec trader-ops-openviking ov doctor
```

在开发 Mac 上建立 SSH 隧道，并保持该终端运行：

```bash
ssh -N -L 3180:127.0.0.1:3180 dsh-server
```

在另一个终端从服务 journal 读取当前经过身份验证的 Web URL；必要时把它的 host 替换为 `127.0.0.1:3180`，再在本机打开：

```bash
ssh -t dsh-server 'sudo journalctl -u dsh-trader-ops -n 100 --no-pager'
```

URL token 可以访问当前进程的浏览器界面。不要把它粘贴到聊天中，也不要保存在共享日志里。

## 每次发布

1. 使用新的、已评审的完整 commit SHA 运行 `install-debian-release.sh`。
2. 加载 `/etc/deepseek-harness/trader-ops.env`，再以 `dsh` 身份针对新发布运行 `bootstrap-profile.sh` 和 `verify-deployment.sh`，然后才重启服务。
3. 执行任何数据迁移前，备份 `/var/lib/openviking` 与 `/var/lib/deepseek-harness`。
4. 重启 `dsh-trader-ops`，重复监听地址、健康、空 skill 和空 knowledge 检查，并保留上一发布。
5. 失败时，把 `current` 原子指回上一个已验证发布，再重启 Harness。只有失败发布执行过明确的不兼容迁移时，才恢复持久化数据。

## 上线前门禁

- OpenViking `/health` 与 `/ready` 成功，`ov doctor` 通过，且容器重启后数据仍然存在。
- `dsh --dump-config` 中只有一个预期的 `openviking-memory-runtime`，并包含 `trader-ops-tool-policy`、`trader-ops-skills` 与 AIHubMix 提供方。
- 实际环境不存在模板或已暴露凭据，密钥不会出现在 Git、日志、进程参数或 shell history 中。
- AIHubMix 的端点归属、模型路由、保留策略与数据处理条款必须覆盖每一类模型可见数据并通过评审。
- 在缺少业务知识、生产 skill、可信用户身份、持久审批与 Trader Ops MCP 授权层时，Harness 保持只读且只能经 SSH 隧道访问。
- `tool-access.yaml` 以 `enforced: true`、显式环境和默认拒绝加载。未来业务 MCP 服务必须重复执行主体、资源与参数级授权。

## 备份与监控

备份至少覆盖 `/var/lib/openviking`、`/var/lib/deepseek-harness`、`/etc/deepseek-harness` 以及未来的外部审批或审计存储。监控应覆盖 OpenViking 健康/就绪状态、Harness 与 Ollama 服务、插件连接失败、检索延迟、磁盘容量以及未来的 MCP 工具失败。自动恢复不得重放非幂等业务写操作。
