---
description: "面向企业微信智能机器人持久长连接渠道的 DeepSeek Harness Linux 生产部署与验收流程。"
---

# 在 Linux 上部署企业微信 Agent

[English](wecom-linux-deployment.md) | 中文

## 概要

本指南把一个企业微信智能机器人作为持久 DeepSeek Harness Agent 部署到公司 Linux 主机。部署会固定一个仓库版本，把运行数据放在发布目录之外，把凭据放在 Git 之外，并由 systemd 运行专用 `wecom` profile。一个 BotID 只允许一个活跃进程，因此生产切换必须先停止旧主机，再启动 Linux。Linux 部署人员负责所有主机专属命令，并且必须在批准发布前于目标主机完成验收流程。

## 目录

- [部署结果](#deployment-outcome)
- [前置条件](#prerequisites)
- [准备发布版本](#prepare-the-release)
- [准备 Linux 主机](#prepare-the-linux-host)
- [安装并构建 DSH](#install-and-build-dsh)
- [创建企业微信 profile](#create-the-wecom-profile)
- [配置凭据](#configure-credentials)
- [安装 systemd 服务](#install-the-systemd-service)
- [切换 BotID](#cut-over-the-botid)
- [验收流程](#acceptance-procedure)
- [运维与回滚](#operations-and-rollback)
- [安全检查表](#security-checklist)
- [故障排查](#troubleshooting)
- [延伸阅读](#further-exploration)
- [开发说明](#dev-note)

-----

<a id="deployment-outcome"></a>
## 部署结果

完成后的部署包含一个专用操作系统用户、一个不可变源码发布版本、一个持久 Harness home、一个受限 Agent 工作区、一个由 root 持有的凭据文件，以及一个 systemd 服务。Web 管理端只监听 loopback；企业微信通过出站 WebSocket 连接访问 Agent，不需要入站回调 URL。

使用以下目录布局：

```text
/opt/deepseek-harness/
├── releases/<release-ref>/
└── current -> releases/<release-ref>/

/var/lib/deepseek-harness/
/srv/dsh-workspace/
/etc/deepseek-harness/wecom.env
/etc/systemd/system/dsh-wecom.service
```

`dsh` 用户持有 `/var/lib/deepseek-harness` 与 `/srv/dsh-workspace`。安装后，root 持有发布目录、凭据文件和 systemd unit。

<a id="prerequisites"></a>
## 前置条件

在维护窗口开始前收集以下输入：

- 一个包含 `packages/channel/channel-wecom` 及其全部关联生成文档的仓库 commit 或 tag。
- 一台 Linux x64 或 arm64 主机，安装 Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm `11.7.0`。
- Git、Python 3、C/C++ 构建工具链、CA 证书，以及发行版支持时的 `bubblewrap`。
- 到模型 endpoint 和 `openws.work.weixin.qq.com:443` 的出站 TLS 访问。
- 企业微信 BotID 和机器人 secret。
- 明确允许的企业微信用户 id 列表；启用群聊时还需要允许的 chat id 列表。
- 一个模型凭据和已经验证的 provider/model route。
- 一个与机器人 secret 分开存储的高熵 `WECOM_SESSION_KEY`。

生产环境不得使用通配 allowlist。除非浏览器管理是单独经过评审的需求，否则不要通过反向代理暴露 3180 端口。

### 选择迁移模式

全新部署会创建新的渠道映射，不复制旧 Session 历史。此模式需要生成新的 `WECOM_SESSION_KEY`。

连续性部署会保留现有 `WECOM_SESSION_KEY`，并从旧主机迁移持久 Harness 数据。迁移期间两台主机必须使用完全相同的仓库版本，因为此预发布项目不承诺不同磁盘格式版本之间的兼容性。迁移前备份完整的源 Harness home；在 Linux 上重新构建 profile，不复制其 `node_modules`，并改写所有主机专属绝对路径。

<a id="prepare-the-release"></a>
## 准备发布版本

部署前把全部变更提交到公司仓库。不要部署未提交的工作站目录。

```sh
git status --short
git add <reviewed-paths>
git commit -m "feat: add production WeCom agent channel"
git push origin <branch>
git tag <release-ref>
git push origin <release-ref>
```

在变更单中记录发布 commit：

```sh
git rev-parse <release-ref>
```

评审人员必须确认 commit 中没有 `.env` 文件、机器人 secret、模型 key、Session 身份密钥、真实 BotID、真实用户 id 或仅适用于工作站的绝对路径。

<a id="prepare-the-linux-host"></a>
## 准备 Linux 主机

以下包管理命令适用于 Ubuntu 或 Debian。其他发行版的 Linux 部署人员必须转换包名，并记录实际安装版本。

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential python3 bubblewrap
```

通过公司批准的软件源安装受支持的 Node.js 版本。通过 Corepack 启用仓库指定的 pnpm 版本：

```sh
node --version
sudo corepack enable
sudo corepack prepare pnpm@11.7.0 --activate
pnpm --version
command -v pnpm
```

创建服务账号和持久目录：

```sh
sudo useradd --system --create-home --shell /bin/bash dsh
sudo mkdir -p /opt/deepseek-harness/releases
sudo mkdir -p /var/lib/deepseek-harness
sudo mkdir -p /srv/dsh-workspace
sudo mkdir -p /etc/deepseek-harness
sudo chown -R dsh:dsh /var/lib/deepseek-harness /srv/dsh-workspace
sudo chmod 700 /var/lib/deepseek-harness
```

从目标网络验证 DNS 和出站 TLS：

```sh
getent hosts openws.work.weixin.qq.com
openssl s_client -connect openws.work.weixin.qq.com:443 -servername openws.work.weixin.qq.com </dev/null
```

TLS 命令必须完成证书握手。防火墙、代理、证书或 DNS 故障都会阻止部署。

<a id="install-and-build-dsh"></a>
## 安装并构建 DSH

把不可变发布版本克隆到独立目录，再通过 `current` 软链接发布：

```sh
sudo git clone --branch <release-ref> --depth 1 <company-repository-url> /opt/deepseek-harness/releases/<release-ref>
sudo chown -R dsh:dsh /opt/deepseek-harness/releases/<release-ref>
sudo ln -sfn /opt/deepseek-harness/releases/<release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
git rev-parse HEAD
```

观察到的 `HEAD` 必须等于变更单中记录的 commit。安装锁定的依赖图并构建仓库：

```sh
sudo -u dsh env CI=true pnpm install --frozen-lockfile
sudo -u dsh pnpm run build
```

配置 profile 前运行渠道自有测试和类型检查：

```sh
sudo -u dsh ./node_modules/.bin/vitest run packages/channel/channel-wecom/tests
sudo -u dsh ./node_modules/.bin/tsc -p packages/channel/channel-wecom/tsconfig.json --noEmit
```

所有渠道测试都必须通过，类型检查必须以状态 0 退出。任一命令失败时停止部署。

检查通过后，把已构建发布版本设置为服务账号只读：

```sh
sudo chown -R root:root /opt/deepseek-harness/releases/<release-ref>
```

<a id="create-the-wecom-profile"></a>
## 创建企业微信 profile

设置生产 Harness home，并把渠道包添加为 profile 依赖。此命令安装包；后续 `cordis.patch.yml` 配置项负责挂载 Cordis 插件。

```sh
cd /opt/deepseek-harness/current
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom add ./packages/channel/channel-wecom
```

设置 `/var/lib/deepseek-harness/profiles/wecom/package.json`，使其使用 base 与 Web application bundle，并仅在启动时加载 patch。保留 Linux 主机生成的 dependency 值。

```json
{
  "name": "dsh-profile-wecom",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-channel-wecom": "link:/opt/deepseek-harness/current/packages/channel/channel-wecom"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ],
      "patchReload": "startup"
    }
  }
}
```

### 创建无人值守 preset

把随附 standard preset 复制到生产 profile：

```sh
sudo -u dsh mkdir -p /var/lib/deepseek-harness/profiles/wecom/agent-presets
sudo -u dsh cp -R packages/preset/agent-presets/presets/standard /var/lib/deepseek-harness/profiles/wecom/agent-presets/standard
```

在复制的 `agent.cordis.yml` 中，把 persona 文本替换为固定的无人值守渠道指令，并禁用 `tool-ask-user` 配置项。结果必须包含以下值：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent serving an unattended enterprise WeCom text channel. Answer directly and never request interactive input.

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  disabled: true
```

设置复制后的 `preset.yml` 元数据：

```yaml
name: Enterprise WeCom unattended mode
description: Standard coding tools without interactive questions for the enterprise WeCom long-connection channel.
order: 1
```

### 创建生产 patch

创建 `/var/lib/deepseek-harness/profiles/wecom/cordis.patch.yml`。验证前替换所有占位符。

```yaml
- id: modules
  disabled: true

- id: client-hmr
  disabled: true

- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: '/var/lib/deepseek-harness/profiles/wecom/agent-presets'
        trust: system
    includeShippedRoot: false
    includeUserRoot: false

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      wecom-channel:
        sandbox: workspace-write
        approval: never

- insert:
    - id: channel-wecom
      name: '@deepseek-ai/dsh-channel-wecom'
      config:
        botId: '<wecom-bot-id>'
        secretEnv: WECOM_BOT_SECRET
        sessionKeyEnv: WECOM_SESSION_KEY
        workspacePath: '/srv/dsh-workspace'
        agentPreset: standard
        permissionPreset: wecom-channel
        allowedUsers:
          - '<admitted-user-id>'
        allowedChats: []
        groupConversationMode: shared
        messages:
          processing: '正在处理…'
          timeout: '处理超时，请稍后重试。'
          failure: '处理失败，请稍后重试。'
          emptyReply: '任务已完成，但没有文本回复。'
          unauthorized: '当前用户或会话未获授权。'
          duplicate: '该消息正在处理中。'
```

在群聊访问单独获批前使用 `allowedChats: []`。启用群聊时添加准确的群 id，不得使用 `"*"`。

保护 profile 文件：

```sh
sudo chown -R dsh:dsh /var/lib/deepseek-harness/profiles/wecom
sudo chmod -R go-rwx /var/lib/deepseek-harness/profiles/wecom
```

<a id="configure-credentials"></a>
## 配置凭据

创建 `/etc/deepseek-harness/wecom.env`，不要写 shell export，也不要在 `=` 两侧添加空格。使用选定模型提供方要求的凭据名称。

```dotenv
DEEPSEEK_API_KEY=<production-model-key>
# DEEPSEEK_BASE_URL=<company-model-gateway-url>
WECOM_BOT_SECRET=<wecom-bot-secret>
WECOM_SESSION_KEY=<stable-high-entropy-session-key>
```

仅在全新部署时生成 Session 身份密钥：

```sh
openssl rand -hex 32
```

设置所有者和权限：

```sh
sudo chown root:dsh /etc/deepseek-harness/wecom.env
sudo chmod 640 /etc/deepseek-harness/wecom.env
```

验证有效 profile，不在命令行放置 secret，也不打印展开后的配置：

```sh
sudo -u dsh bash -lc '
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  export DSH_HOME=/var/lib/deepseek-harness
  cd /opt/deepseek-harness/current
  pnpm dsh --profile wecom --dump-config >/dev/null
'
```

命令必须以状态 0 退出。继续前解决缺少凭据、未知包、无效 preset root 和无效绝对路径。

切换 BotID 前独立验证模型：

```sh
sudo -u dsh bash -lc '
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  export DSH_HOME=/var/lib/deepseek-harness
  cd /opt/deepseek-harness/current
  pnpm dsh --profile headless "Reply only MODEL-OK"
'
```

最终输出必须包含 `MODEL-OK`。配置展开成功不能替代真实模型请求。

<a id="install-the-systemd-service"></a>
## 安装 systemd 服务

通过 `command -v pnpm` 确认系统级 pnpm 路径，再创建 `/etc/systemd/system/dsh-wecom.service`。实际路径不同时替换 `/usr/local/bin/pnpm`。

```systemd
[Unit]
Description=DeepSeek Harness enterprise WeCom Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh
Group=dsh
WorkingDirectory=/opt/deepseek-harness/current
Environment=DSH_HOME=/var/lib/deepseek-harness
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/deepseek-harness/wecom.env
ExecStart=/usr/local/bin/pnpm dsh --profile wecom --port 3180 --no-open
Restart=always
RestartSec=10
TimeoutStopSec=30
UMask=0077
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/deepseek-harness /srv/dsh-workspace

[Install]
WantedBy=multi-user.target
```

验证并启用 unit，但不要在旧 BotID owner 停止前启动：

```sh
sudo systemd-analyze verify /etc/systemd/system/dsh-wecom.service
sudo systemctl daemon-reload
sudo systemctl enable dsh-wecom
```

不要添加 `PrivateUsers=true`；Linux 沙箱会选择 `bubblewrap` 或 Landlock，并且必须探测目标内核与用户 namespace policy。下面的工作区验收测试是所选沙箱后端的部署证据。

<a id="cut-over-the-botid"></a>
## 切换 BotID

企业微信对一个 BotID 只允许一个活跃进程，因此需要安排一个维护窗口。启动 Linux 前先停止当前 owner。

对于由本文所述 LaunchAgent 管理的 macOS 主机：

```sh
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.deepseek-harness.wecom.plist"
```

确认旧进程及其出站连接已经停止。然后启动 Linux：

```sh
sudo systemctl start dsh-wecom
sudo systemctl status dsh-wecom --no-pager
```

Linux 持有 BotID 时，不要重启旧主机。验收后删除或禁用旧主机的自动启动注册。

-----

<a id="acceptance-procedure"></a>
## 验收流程

Linux 部署人员针对发布 commit 记录每项结果。任何必选检查失败都会阻止生产批准。

### 1. 进程与重启状态

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p NRestarts
sudo journalctl -u dsh-wecom -n 200 --no-pager
```

服务为 `active` 和 `running`、`NRestarts` 保持稳定，且 journal 中没有凭据、profile、preset、workspace、sandbox 或认证错误时通过。

### 2. 本地监听与出站连接

```sh
curl -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:3180/
sudo ss -ltnp | grep ':3180'
sudo ss -tpn | grep ':443'
```

未认证 HTTP 请求返回 `401`、3180 端口只监听 loopback，且服务持有稳定出站 TLS 连接时通过。此纯渠道部署不得在主机或网络防火墙中开放 3180 端口。

### 3. 已授权对话

允许的用户在单聊中发送以下唯一消息：

```text
Production verification: reply only PROD-PONG.
```

企业微信先显示配置的处理中消息，再在 `turnTimeoutMs` 之前显示 `PROD-PONG` 时通过。确认 systemd 服务在此轮次中没有重启。

### 4. Session 连续性

同一用户按顺序发送以下消息：

```text
Remember verification code 7391 and reply only REMEMBERED.
```

```text
What verification code did I ask you to remember?
```

第二个回答包含 `7391` 时通过。此项验证稳定会话映射、持久 Session 历史、Agent resume，以及恢复后的 provider/model 选择。

### 5. 受限工作区写入

允许的用户发送：

```text
Create deployment-smoke.txt in the workspace with the exact content wecom-linux-ok, then report the result.
```

在 Linux 上验证文件：

```sh
sudo -u dsh test "$(cat /srv/dsh-workspace/deployment-smoke.txt)" = "wecom-linux-ok"
```

文件存在且内容完全一致时通过。另行执行经过批准的负向测试，让 Agent 尝试写入 `/srv/dsh-workspace` 之外；只有沙箱拒绝写入且工作区之外未出现文件时才通过。

### 6. 准入策略

存在测试身份时，分别测试一个允许的单聊用户、一个未允许用户和一个未允许群聊。允许的用户能够对话，且其他发送方均收到配置的未授权回复而不启动模型轮次时通过。

### 7. 重启恢复

```sh
sudo systemctl restart dsh-wecom
sudo systemctl status dsh-wecom --no-pager
```

重新连接后，允许的用户再次询问验证码 7391。服务返回记忆值，且 journal 中没有持久化或认证错误时通过。

### 8. 监管恢复

```sh
sudo systemctl kill --signal=SIGTERM dsh-wecom
sleep 15
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p NRestarts
```

systemd 启动替代进程、服务恢复为 `active` 和 `running`，且新的企业微信消息正常完成时通过。

### 9. 日志隐私

完成全部测试后检查服务 journal。其中没有模型凭据、机器人 secret、Session 身份密钥、已接受的原始消息文本、原始 provider 用户 id 或 provider 调试帧时通过。

### 验收记录

在发布工单中记录以下字段：

| 字段 | 必需证据 |
|---|---|
| 发布版本 | Git commit 与 tag |
| 主机 | Linux 发行版、kernel、architecture、Node 与 pnpm 版本 |
| 服务 | `ActiveState`、`SubState` 与稳定的 `NRestarts` |
| 网络 | 仅 loopback 的 3180 和已建立的出站 TLS |
| 模型 | `MODEL-OK` headless 请求 |
| 企业微信 | 处理中回复与最终 `PROD-PONG` |
| 持久化 | 验证码 7391 在服务重启后保留 |
| 沙箱 | 工作区写入成功，外部写入失败 |
| 准入 | 精确 allowlist 按配置允许和拒绝 |
| 隐私 | Journal 检查未发现 secret 或已接受的原始消息数据 |

<a id="operations-and-rollback"></a>
## 运维与回滚

只使用 systemd 管理进程：

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl restart dsh-wecom
sudo systemctl stop dsh-wecom
sudo journalctl -u dsh-wecom -f
```

通过公司的加密备份系统备份 `/var/lib/deepseek-harness` 和 `/etc/deepseek-harness/wecom.env`。备份访问策略必须把 `WECOM_SESSION_KEY`、模型凭据和机器人 secret 作为生产 secret 处理。

### 升级

在新的 `/opt/deepseek-harness/releases/<release-ref>` 目录中构建并测试每个发布版本。停止服务、更新 `/opt/deepseek-harness/current`、针对新版本重新协调 profile 依赖，运行配置与模型检查，然后启动服务并重复验收流程。

### 回滚

更改发布软链接前停止服务：

```sh
sudo systemctl stop dsh-wecom
sudo ln -sfn /opt/deepseek-harness/releases/<previous-release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom install
sudo systemctl start dsh-wecom
```

不得跨不兼容 schema 或 Session format 回滚现有持久数据目录。当发布说明或变更评审指出磁盘格式变化时，恢复与目标版本匹配的升级前备份。

<a id="security-checklist"></a>
## 安全检查表

- 服务以 `dsh` 而不是 root 运行。
- Git 和日志中没有凭据值或真实 provider 标识符。
- `/etc/deepseek-harness/wecom.env` 为 `root:dsh`、mode `0640` 或更严格。
- profile 使用精确的 `allowedUsers` 和 `allowedChats` 配置项；两个列表均不包含 `"*"`。
- 企业微信 permission preset 使用 `workspace-write` 或 `read-only`、`approval: never`，且绝不使用 `danger-full-access`。
- 无人值守 preset 禁用 `tool-ask-user`。
- workspace 是由 `dsh` 持有的现有绝对目录。
- 3180 端口保留在 loopback，并且不对网络开放。
- 主机只允许到部署所需的已批准模型与企业微信目标的出站 TLS。
- 只有一个活跃进程使用该 BotID。
- 备份以相同的生产访问控制保存 Session 身份密钥和持久数据。

<a id="troubleshooting"></a>
## 故障排查

- **服务进入重启循环**——检查 `systemctl status` 和 journal 中的第一个错误；修正 profile、可执行文件路径、凭据文件权限或绝对目录，不要增加 `RestartSec`。
- **认证超时**——验证 BotID 与机器人 secret，停止使用该 BotID 的所有其他进程，并测试到企业微信 endpoint 的 DNS 与出站 TLS。
- **用户只看到处理中回复**——检查模型连接与 `turnTimeoutMs`；确认配置的 provider 和 model 能完成 headless 模型测试。
- **用户看到超时回复**——检查已关联 Agent 失败和工具耗时；配置的 timeout 是最终 deadline，不是 retry policy。
- **恢复的会话没有模型**——确认部署包含渠道 resume 修复，并运行已记录的发布 commit。
- **工具报告 `SANDBOX_UNAVAILABLE`**——验证目标 kernel 的 `bubblewrap`、用户 namespace 与 Landlock 支持；不要把渠道切换为 `danger-full-access`。
- **第二台主机断开服务**——找到并停止使用该 BotID 的其他进程；此渠道没有 leader election。
- **旧对话丢失**——确认连续性部署同时保留了 `WECOM_SESSION_KEY` 和匹配的持久 Harness 数据。

<a id="further-exploration"></a>
## 延伸阅读

- [企业微信渠道参考](../../../packages/channel/channel-wecom/README.zh.md)——配置字段、交付生命周期、安全与已知限制。
- [配置模型](providers.zh.md)——提供方凭据、自定义网关、模型选择与兼容性设置。
- [应用 profile](../../../packages/boot/app-boot/README.zh.md)——profile 目录、bundle 组合与 patch 加载。
- [Linux 沙箱提供方](../../../packages/sandbox/sandbox-local/README.zh.md)——`bubblewrap`、Landlock、执行限制与失败行为。

-----

<a id="dev-note"></a>
## 开发说明

<details>
<summary>非权威工作上下文</summary>

无。

</details>
