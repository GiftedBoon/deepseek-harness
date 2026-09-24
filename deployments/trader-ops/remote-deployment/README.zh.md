# 远程部署记录

[English](README.md) | 中文

本文记录远程 Debian 主机上已验证的 Trader Ops 部署，包括正在运行的发布版本、服务连接方式、服务账号切换后的检查结果，以及下一次安全验证的操作路径。本文不包含凭据值、企业微信身份值、Session Key、URL token 或消息内容。

## 概要

远程部署在一台 Debian 主机上运行 Harness 和 OpenViking。Harness 监听回环地址，socket proxy 对外提供选定的内网地址。OpenViking 保持在回环端口，Ollama 保持在 Docker bridge。`dsh-trader-ops` systemd 服务以 `cfi:cfi` 运行，并加载带 Trader Ops patch 的 `web` profile。

已部署的渠道会在恢复映射的持久 Session 前检查该 Session 是否仍然存在。映射的 Session 不存在时，渠道会创建新的 Session，因此删除 Session 不会再阻止下一条企业微信消息创建新会话。

## 目录

- [部署标识](#deployment-identity)
- [服务与网络](#service-and-network)
- [已应用配置](#configuration-applied)
- [验证证据](#verification-evidence)
- [企业微信 Session 重建](#wecom-session-recreation)
- [日常运维](#routine-operations)
- [安全约束](#safety-constraints)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="deployment-identity"></a>
## 部署标识

| 项目 | 记录值 |
|---|---|
| SSH 目标 | `dsh-server` |
| 主机名 | `debian` |
| 验证日期 | `2026-09-24` |
| 发布标记 | `/opt/deepseek-harness/current/.trader-ops-built` |
| 发布入口 | `/opt/deepseek-harness/current` |
| Harness 服务 | `dsh-trader-ops.service` |
| Profile | `web` |
| 服务账号 | `cfi:cfi` |

发布标记给出构建当前版本所用的完整源码 commit。运行中的服务和 OpenViking MCP 代理均使用 `cfi` 账号。

<a id="service-and-network"></a>
## 服务与网络

| 组件 | 观察状态 |
|---|---|
| Harness 服务 | `active/running` |
| 当前 systemd 重启次数 | `0` |
| Harness 回环响应 | 未经过 Web 身份验证时返回 HTTP `401` |
| 内网入口 | `192.168.4.103:3180` |
| 内网响应 | 未经过 Web 身份验证时返回 HTTP `401` |
| OpenViking 健康状态 | HTTP `200` |
| OpenViking 就绪状态 | HTTP `200` |
| 监听地址 | Harness 使用 `127.0.0.1:3180`；socket proxy 使用 `192.168.4.103:3180` |

服务通过 systemd 使用 `trader-ops` patch 文件启动已构建 CLI，把 Harness 绑定到 `127.0.0.1:3180`，并声明 `192.168.4.103:3180` 为内网 authority。代理只暴露内网地址，不改变 Harness 使用的回环绑定。

<a id="configuration-applied"></a>
## 已应用配置

远程运维人员在安装发布版本后完成了运行时配置和重启。

- `web` profile 加载基础运行时、AIHubMix 路由、OpenViking memory 集成和企业微信渠道 patch。
- 企业微信渠道保持精确白名单，不使用通配条目。
- 渠道使用无人值守的非交互 preset 和受限工作区权限 preset。
- Harness 的 Web endpoint 保持在回环地址；内网 socket proxy 是唯一额外入口。
- 凭据保留在远程主机的 root 管理环境文件中，不复制到本仓库。

<a id="verification-evidence"></a>
## 验证证据

配置后对远程主机执行了以下检查：

| 检查 | 结果 |
|---|---|
| systemd 状态 | `ActiveState=active`、`SubState=running` |
| systemd 监管 | 当前激活周期 `NRestarts=0` |
| 服务归属 | Harness 和 OpenViking MCP 代理以 `cfi:cfi` 运行；发布、profile 与工作区目录归 `cfi:cfi` 所有 |
| Harness 身份验证边界 | 未提供凭据时，回环和内网请求都返回 `401` |
| OpenViking 健康与就绪 | 两个 endpoint 都返回 `200` |
| 监听范围 | Harness 监听回环地址；socket proxy 暴露选定的内网地址 |
| Profile 验证 | OpenViking 补丁、企业微信最小 preset、策略、Skill 和知识检查均通过 |

这些状态检查证明服务及其依赖已就绪，但不能替代删除映射 Session 后发送真实企业微信消息的验收；该行为仍需要运维人员执行一次验收消息。

<a id="wecom-session-recreation"></a>
## 企业微信 Session 重建

删除已有映射 Session 后，按以下顺序执行验收：

1. 由同一个获准企业微信用户发送一条新的单聊消息。
2. 确认机器人发送正常的处理中响应并完成新的回合。
3. 确认新消息关联到新创建的 Session，而不是已删除的标识符。
4. 如果消息失败，只记录时间戳和服务状态；不要把凭据、URL token、用户 ID、群聊 ID 或消息内容复制到 issue。

预期结果是在不手动创建 Session、也不修改 `WECOM_SESSION_KEY` 的情况下完成新的回合。

<a id="routine-operations"></a>
## 日常运维

从远程主机检查服务与 endpoint 健康状态：

```bash
sudo systemctl show dsh-trader-ops -p ActiveState -p SubState -p MainPID -p NRestarts
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3180/
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.4.103:3180/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1933/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1933/ready
```

评审过配置变更后，通过运行时脚本重启：

```bash
sudo /opt/deepseek-harness/current/deployments/trader-ops/scripts/restart-runtime.sh
```

发布安装、白名单修改、备份、回滚和日志处理遵循现有的[远程部署运行手册](../DEPLOYMENT.md)。

<a id="safety-constraints"></a>
## 安全约束

- 保留既有企业微信会话映射时，保持 `WECOM_SESSION_KEY` 不变。
- 不得把密钥、身份白名单、Session Key、身份验证 token 或真实消息内容放入 Git 或共享日志。
- 保持 Harness 只监听回环，并且只暴露经过评审的内网代理地址。
- 保持企业微信渠道为非交互模式，并限制在批准的工作区内。
- 发布或数据迁移前，保留完整的 `/var/lib/deepseek-harness` 数据目录。
- 启用本服务前停止拥有同一 BotID 的其他进程；企业微信每个 BotID 只允许一个活跃长连接。

<a id="further-exploration"></a>
## 延伸阅读

- [远程部署运行手册](../DEPLOYMENT.md)——安装、配置、验收、升级和回滚。
- [企业微信 Linux 部署指南](../../../docs/user/guide/wecom-linux-deployment.zh.md)——渠道专属的 Linux 流程与验收检查。
- [企业微信渠道参考](../../../packages/channel/channel-wecom/README.zh.md)——配置与 Session 映射语义。

-----

<a id="dev-note"></a>
## 开发说明

<details>
<summary>非权威维护上下文</summary>

本文是 `2026-09-24` 的部署快照。远程发布版本或运行时连接方式变更后，更新发布标记、入口值、服务状态和验证表。

</details>
