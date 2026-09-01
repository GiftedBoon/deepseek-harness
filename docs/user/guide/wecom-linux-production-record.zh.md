---
description: "记录 2026-09-01 企业微信 Harness Linux 生产实例的发布版本、主机配置、验证证据、运维命令和待办事项。"
---

# 企业微信 Linux 生产部署记录

[English](wecom-linux-production-record.md) | 中文

## 概要

本文记录 2026-09-01 在主机 `debian` 上完成的企业微信 Harness 部署。服务从固定 Git tag 启动，使用独立系统账号、持久数据目录、受限工作区、root 持有的凭据文件、systemd 监管，以及带密码登录的内网 Nginx 入口。记录不包含 BotID、企业微信用户或群聊 ID、API Key、机器人 Secret、Session Key、Web 登录密码或启动令牌。通用部署步骤及配置字段仍以[企业微信 Linux 部署指南](wecom-linux-deployment.zh.md)为准。

## 目录

- [部署标识](#deployment-identity)
- [主机与运行时](#host-and-runtime)
- [目录与权限](#directories-and-permissions)
- [Profile 配置](#profile-configuration)
- [凭据与模型](#credentials-and-model)
- [systemd 服务](#systemd-service)
- [内网 Web 访问](#internal-web-access)
- [验收结果](#acceptance-results)
- [待完成事项](#open-items)
- [日常运维](#routine-operations)
- [升级与回滚](#upgrade-and-rollback)
- [安全约束](#security-constraints)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="deployment-identity"></a>
## 部署标识

本实例是全新部署，不迁移旧 Session 数据。以下标识定位正在运行的不可变源码发布版本。

| 项目 | 值 |
|---|---|
| 部署日期 | `2026-09-01` |
| 发布 tag | `wecom-prod-2026-09-01` |
| Git commit | `de30d099356043e6d034c12d8715e6e7377eb659` |
| 发布目录 | `/opt/deepseek-harness/releases/wecom-prod-2026-09-01` |
| 当前版本链接 | `/opt/deepseek-harness/current` |
| 服务名 | `dsh-wecom.service` |
| Profile | `wecom` |

`/opt/deepseek-harness/current` 解析到上表中的发布目录。发布目录在构建与测试完成后归 `root:root` 所有。

<a id="host-and-runtime"></a>
## 主机与运行时

生产进程使用系统路径中的 Node 和 pnpm，不依赖登录用户的 Conda 或 NVM 环境。

| 项目 | 已验证值 |
|---|---|
| 操作系统 | Debian GNU/Linux 12 (bookworm) |
| Kernel | `6.1.0-18-amd64` |
| Architecture | `x86_64` |
| Node.js | `v24.15.0`，位于 `/usr/local/bin/node` |
| Corepack | 系统安装，可由 `dsh` 用户访问 |
| pnpm | `11.7.0`，位于 `/usr/local/bin/pnpm` |
| GCC | `12.2.0` |
| bubblewrap | `0.8.0` |
| 服务账号 | `dsh`, UID `999`, GID `996` |

DNS 能解析 `openws.work.weixin.qq.com`，目标端口 `443` 的 TLS 握手返回 `Verification: OK`。运行中的 Node 进程与企业微信端点保持出站 TLS 连接。

<a id="directories-and-permissions"></a>
## 目录与权限

源码发布、运行数据、工作区和凭据彼此分离。服务只能写入持久 Harness home 和工作区。

| 路径 | 所有者 | Mode | 用途 |
|---|---|---|---|
| `/opt/deepseek-harness/releases/wecom-prod-2026-09-01` | `root:root` | 发布内容自身的只读权限 | 固定源码与构建产物 |
| `/opt/deepseek-harness/current` | root 管理的符号链接 | 不适用 | 指向当前发布目录 |
| `/var/lib/deepseek-harness` | `dsh:dsh` | `0700` | Profile、Session、设置和运行数据 |
| `/srv/dsh-workspace` | `dsh:dsh` | `0700` | Agent 唯一允许写入的工作区 |
| `/etc/deepseek-harness` | `root:dsh` | `0750` | 凭据目录；组权限允许服务账号遍历 |
| `/etc/deepseek-harness/wecom.env` | `root:dsh` | `0640` | 模型与企业微信凭据 |
| `/etc/systemd/system/dsh-wecom.service` | `root:root` | 系统 unit 默认权限 | systemd 服务定义 |

`dsh` 必须对 `/etc/deepseek-harness` 具有目录遍历权限，否则即使 `wecom.env` 是 `root:dsh 0640`，服务仍会收到 `EACCES`。

<a id="profile-configuration"></a>
## Profile 配置

Profile 位于 `/var/lib/deepseek-harness/profiles/wecom`。`package.json` 组合 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`，并设置 `patchReload: startup`。

渠道依赖使用发布目录中的本地链接。升级后必须通过 `dsh plugin --profile wecom install` 重新协调该链接。

复制的 `standard` preset 使用固定的无人值守 persona，并禁用 `@deepseek-ai/dsh-tool-ask-user`。渠道使用 `wecom-channel` 权限 preset，其沙箱为 `workspace-write`，审批模式为 `never`；不得改为 `danger-full-access`。

`cordis.patch.yml` 禁用 `client-hmr`，只加载复制的 system-trust preset root，并挂载 `@deepseek-ai/dsh-channel-wecom`。渠道使用一个精确用户 allowlist、空的群聊 allowlist、`per-user` 群聊会话模式，以及 `/srv/dsh-workspace` 工作区。Web 应用包含插件管理模块。

DSH Web 服务只绑定 loopback。`web-runtime` 设置 `openBrowser: false`、`printUrl: false`、`surfaceContext: false`，并仅信任 `192.168.3.213:9000`，因此无人值守服务不会把启动令牌 URL 写入新的启动日志，也不会把 Web UI 地址加入模型上下文。Connection 应用相同的受信 authority，并通过 `DSH_WEB_LOGIN_PASSWORD` 凭据引用启用 `trader` 表单账号。

<a id="credentials-and-model"></a>
## 凭据与模型

凭据文件包含 `DEEPSEEK_API_KEY`、`WECOM_BOT_SECRET`、高熵 `WECOM_SESSION_KEY` 和 `DSH_WEB_LOGIN_PASSWORD`。本记录不保存这些值或其长度。

部署使用 `deepseek-official` provider 和 `deepseek-v4-flash` 默认模型。真实 headless 请求返回 `MODEL-OK`，证明模型凭据和外部请求链路可用。

`WECOM_SESSION_KEY` 定义企业微信会话身份映射。备份、恢复或迁移必须保留该值及完整 `/var/lib/deepseek-harness`；更换该值会创建新的映射并失去旧对话连续性。

<a id="systemd-service"></a>
## systemd 服务

`dsh-wecom.service` 以 `dsh:dsh` 运行，工作目录为 `/opt/deepseek-harness/current`，并通过 `/usr/local/bin/pnpm dsh --profile wecom --port 3180 --no-open` 启动。unit 从 `/etc/deepseek-harness/wecom.env` 加载凭据。

服务使用 `Restart=always`、`RestartSec=10`、`TimeoutStopSec=30`、`UMask=0077`、`PrivateTmp=true` 和 `ProtectSystem=strict`。`ReadWritePaths` 仅允许 `/var/lib/deepseek-harness` 与 `/srv/dsh-workspace`。

服务已启用到 `multi-user.target`。密码登录部署后，状态为 `active/running`，当前激活的 `NRestarts=0`。

<a id="internal-web-access"></a>
## 内网 Web 访问

Nginx 监听 `192.168.3.213:9000`，并把 HTTP 与 WebSocket 流量代理到 `127.0.0.1:3180`。上游端口仍只对 loopback 开放。内网用户打开 `http://192.168.3.213:9000/`，以 `trader` 登录，然后获得最长 30 天有效的普通 authority-bound 浏览器 cookie。新浏览器或清除站点数据后需要重新输入密码；普通 DSH 重启不会使未过期 cookie 失效。

Nginx site 位于 `/etc/nginx/sites-available/dsh-wecom`，并通过 `/etc/nginx/sites-enabled/dsh-wecom` 启用。它按客户端地址把登录 `POST` 限制为每分钟 10 次，并允许 5 次突发；普通页面与 WebSocket 流量不计入。本部署在受信内网中使用明文 HTTP，不将 `9000` 端口暴露到公网。

<a id="acceptance-results"></a>
## 验收结果

以下结果来自部署主机和企业微信客户端上的实际操作。

| 检查 | 结果 |
|---|---|
| 锁文件安装 | `pnpm install --frozen-lockfile` 成功 |
| 仓库构建 | `pnpm run build` 成功 |
| 渠道测试 | 8 个测试文件、27 项测试全部通过 |
| 渠道类型检查 | `tsc -p packages/channel/channel-wecom/tsconfig.json --noEmit` 退出状态为 0 |
| Profile 展开 | `pnpm dsh --profile wecom --dump-config` 退出状态为 0 |
| 模型请求 | 返回 `MODEL-OK` |
| 服务健康 | `ActiveState=active`、`SubState=running` |
| HTTP 认证 | 未认证的根路径向 `/login` 返回 `303`；登录页返回 `200`；正确凭据返回 `303`；随后携带 cookie 访问根页面返回 `200` |
| 登录输入上限 | 声明长度为 8,193 字节的表单请求体返回 `413` |
| 登录本地化 | `Accept-Language: zh-CN` 返回 `Content-Language: zh-CN` |
| 内网反向代理 | `http://192.168.3.213:9000/login` 返回 `200` |
| 监听范围 | `3180` 仅监听 `127.0.0.1` |
| 企业微信连接 | Node 进程持有到 `openws.work.weixin.qq.com:443` 的已建立连接 |
| 授权单聊 | 先返回处理中消息，最终返回 `PROD-PONG` |
| Session 连续性 | 同一用户后续请求能恢复验证码 `7391` |
| 工作区写入 | `/srv/dsh-workspace/deployment-smoke.txt` 内容为 `wecom-linux-ok` |
| 越界写入 | `/srv/dsh-sandbox-denied.txt` 未创建 |
| 手动重启恢复 | 重启后 Session 仍能恢复验证码 `7391` |
| 监管恢复 | SIGTERM 后 systemd 自动恢复，企业微信返回 `SUPERVISOR-OK` |
| 日志隐私 | 三项 secret 和已接受的验收消息均未出现在 journal 中 |

<a id="open-items"></a>
## 待完成事项

- `allowedChats` 当前为空，因此所有群聊均未获授权。取得准确群聊 ID 后，把 ID 加入列表，保持 `groupConversationMode: per-user`，验证配置并重启服务。
- 未授权用户测试需要另一个企业微信身份。具备测试身份后，确认渠道返回未授权文案且不启动模型轮次。
- 旧 BotID owner 必须保持停止并禁用自动启动；渠道没有 leader election。
- 生产备份尚需接入公司的加密备份系统。备份必须同时覆盖 `/var/lib/deepseek-harness` 和 `/etc/deepseek-harness/wecom.env`。
- 密码登录源码补丁已安装到当前发布目录。下次应用升级必须在新的不可变发布中包含对应仓库提交，不得手工向前复制这些源码文件。

<a id="routine-operations"></a>
## 日常运维

使用 systemd 管理进程，不要从 package bin 或其他 Node 入口直接启动应用。

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl restart dsh-wecom
sudo systemctl stop dsh-wecom
sudo journalctl -u dsh-wecom -f
```

检查服务与监听状态：

```sh
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p MainPID -p NRestarts
curl -o /dev/null -s -w '%{http_code}\n' http://192.168.3.213:9000/login
sudo ss -ltnp | grep ':3180'
sudo ss -ltnp | grep ':9000'
sudo ss -tpn | grep ':443'
```

修改 Nginx site 后，先验证再重载反向代理：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

修改 profile 后必须先展开配置，再重启服务：

```sh
sudo -u dsh -H env PATH=/usr/local/bin:/usr/bin:/bin DSH_HOME=/var/lib/deepseek-harness /bin/bash -c '
  set -euo pipefail
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  cd /opt/deepseek-harness/current
  pnpm dsh --profile wecom --dump-config >/dev/null
'
sudo systemctl restart dsh-wecom
```

<a id="upgrade-and-rollback"></a>
## 升级与回滚

升级时在新的 `/opt/deepseek-harness/releases/<release-ref>` 目录中安装、构建和测试。停止服务后更新 `current` 链接，在新发布版本中运行 profile 依赖协调、配置展开和真实模型测试，再启动服务并重复验收。

```sh
sudo systemctl stop dsh-wecom
sudo ln -sfn /opt/deepseek-harness/releases/<release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
sudo -u dsh -H env PATH=/usr/local/bin:/usr/bin:/bin DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom install
```

回滚不得跨不兼容的 SQLite schema 或 Session format 使用现有数据目录。存在磁盘格式变化时，恢复与目标版本匹配的 `/var/lib/deepseek-harness` 备份和同一部署身份的 `WECOM_SESSION_KEY`。

<a id="security-constraints"></a>
## 安全约束

- 不得把凭据文件、BotID、用户或群聊 ID、管理 token 或真实消息内容提交到 Git。
- `allowedUsers` 和 `allowedChats` 必须使用精确值，不得使用通配符 `"*"`。
- `3180` 端口必须保持只对 loopback 开放。Nginx 是唯一对外提供 Web 应用的 listener，监听内网地址 `192.168.3.213:9000`。
- `9000` 端口通过明文 HTTP 传输登录密码和 bearer cookie。必须将其限定在受信内网；扩大暴露范围前必须添加 TLS。
- 应用不包含账号锁定或尝试限流，因此 Nginx 必须限制重复 `/login` 尝试的速率。
- `wecom-channel` 必须保持 `workspace-write` 或收窄为 `read-only`，并保持 `approval: never`。
- 无人值守 preset 必须继续禁用 `tool-ask-user`。
- 每个 BotID 同时只能由一个进程持有。
- 查看或分享 journal 前必须检查并遮盖 URL token、provider 标识符和其他敏感数据。

<a id="further-exploration"></a>
## 延伸阅读

- [企业微信 Linux 部署指南](wecom-linux-deployment.zh.md)——完整安装、切换、验收和故障排查流程。
- [企业微信渠道参考](../../../packages/channel/channel-wecom/README.zh.md)——配置字段、持久化语义和已知限制。
- [Linux 沙箱提供方](../../../packages/sandbox/sandbox-local/README.zh.md)——bubblewrap、Landlock 和失败行为。

-----

<a id="dev-note"></a>
## 开发说明

<details>
<summary>非权威维护上下文</summary>

本文记录的是 `2026-09-01` 的部署验收快照。维护人员变更发布版本、主机、模型 route、allowlist、目录权限或 systemd unit 后，应更新对应当前状态和重新执行的验收证据。

</details>
