---
description: "DeepSeek Harness 在公司 Linux 主机上的部署、访问、验收、备份、升级、回滚与故障排查运行手册。"
---

# DeepSeek Harness Linux 部署与验收手册

## 概要

本文档指导运维人员把 DeepSeek Harness Web UI 从固定仓库版本部署到公司 Linux 主机，并通过 systemd 持续运行。推荐部署使用独立低权限用户，把程序、持久数据和 Agent 工作区分开，并让 Web 服务只监听 `127.0.0.1`。用户通过 SSH 隧道或带 TLS 和公司身份认证的反向代理访问服务。DeepSeek Harness 当前属于 developer preview，尚未经过安全审计，因此不得把它作为不可信任务的唯一安全隔离措施，也不得直接匿名暴露到公网。

## 目录

- [部署目标](#部署目标)
- [部署边界与重要限制](#部署边界与重要限制)
- [部署输入](#部署输入)
- [第一阶段：准备 Linux 主机](#第一阶段准备-linux-主机)
- [第二阶段：安装并构建项目](#第二阶段安装并构建项目)
- [第三阶段：配置运行数据和凭据](#第三阶段配置运行数据和凭据)
- [第四阶段：部署前冒烟验证](#第四阶段部署前冒烟验证)
- [第五阶段：安装 systemd 服务](#第五阶段安装-systemd-服务)
- [第六阶段：配置访问路径](#第六阶段配置访问路径)
- [部署后验收流程](#部署后验收流程)
- [备份与恢复](#备份与恢复)
- [版本升级](#版本升级)
- [版本回滚](#版本回滚)
- [日常运维](#日常运维)
- [故障排查](#故障排查)
- [上线验收记录模板](#上线验收记录模板)
- [相关资料](#相关资料)
- [开发说明](#开发说明)

-----

## 部署目标

部署完成后，主机应形成以下目录与运行关系：

```text
公司用户
  |
  +-- SSH 隧道，或公司反向代理（TLS + 身份认证）
          |
          +-- 127.0.0.1:3080
                  |
                  +-- systemd: deepseek-harness.service
                          |
                          +-- dsh 低权限用户
                                  |
                                  +-- /opt/deepseek-harness/current
                                  +-- /var/lib/deepseek-harness
                                  +-- /srv/dsh-workspace
```

推荐目录布局：

```text
/opt/deepseek-harness/
├── releases/
│   └── <release-ref>/
└── current -> releases/<release-ref>/

/var/lib/deepseek-harness/
├── profiles/
├── sessions/
├── storages/
├── settings.yaml
└── .credentials.yaml

/srv/dsh-workspace/
/etc/deepseek-harness/dsh.env
/etc/systemd/system/deepseek-harness.service
```

各目录职责如下：

| 路径 | 用途 | 建议所有者 |
|---|---|---|
| `/opt/deepseek-harness/releases/<release-ref>` | 固定版本的源码、依赖和构建产物 | 构建时为 `dsh`，发布后可改为 `root` |
| `/opt/deepseek-harness/current` | 当前运行版本的软链接 | `root` |
| `/var/lib/deepseek-harness` | Profile、设置、凭据、会话和持久状态 | `dsh`，权限 `0700` |
| `/srv/dsh-workspace` | Agent 获准读写的默认工作区 | `dsh` |
| `/etc/deepseek-harness/dsh.env` | systemd 启动环境和密钥 | `root:dsh`，权限 `0640` |

-----

## 部署边界与重要限制

部署评审必须先接受以下边界；任一条不满足时，不应把服务投入公司生产网络。

1. DeepSeek Harness 可以执行模型生成的命令、修改工作区文件、访问网络并调用已安装插件。
2. 项目当前不是经过安全审计的生产级隔离系统。请优先使用专用虚拟机、容器或独立主机，并使用最小权限账号。
3. Web CLI 明确拒绝 `--host 0.0.0.0`。服务应监听 `127.0.0.1`，远程访问通过 SSH 隧道或反向代理完成。
4. 不得把 API Key、公司代理密码或其他凭据写入 Git、systemd unit、部署脚本输出或工单正文。
5. 启动日志打印的 Web URL 可能包含一次性启动令牌。应限制 journal 读取权限，不得把完整 URL 发送到公共聊天或公共日志平台。
6. 默认 `workspace-write` 权限允许 Agent 修改选定工作区和临时目录。运行用户本身仍应无法写入系统目录、其他业务目录和其他用户目录。
7. 预发布版本不承诺旧磁盘格式兼容。升级前必须备份完整的 `DSH_HOME`，回滚时应恢复与旧版本匹配的数据副本。
8. Web 服务不应依赖 Harness 自身令牌承担公司级访问控制。多人长期访问必须增加公司 SSO、VPN、OAuth2 Proxy、零信任网关或等效认证。

-----

## 部署输入

开始部署前，在变更单中记录以下值：

| 输入 | 示例 | 要求 |
|---|---|---|
| 仓库地址 | `ssh://git.example.com/ai/deepseek-harness.git` | 目标主机可访问 |
| 发布引用 | `v0.1.2-company.1` 或完整 commit SHA | 必须固定，不使用浮动分支作为发布身份 |
| Linux 架构 | `x86_64` 或 `aarch64` | 与目标主机一致 |
| Node.js 版本 | `24.x` | 必须满足 `^22.19.0 || >=24.0.0` |
| pnpm 版本 | `11.7.0` | 与根 `package.json` 一致 |
| Web 端口 | `3080` | 仅监听 loopback |
| 工作区 | `/srv/dsh-workspace` | 只放允许 Agent 访问的内容 |
| 模型地址 | DeepSeek 公共 API 或公司兼容 endpoint | 从目标网络可达 |
| 访问方式 | SSH 隧道或反向代理 | 反向代理必须有 TLS 和公司认证 |
| 备份位置 | 公司备份系统或受控对象存储 | 不与主机处于同一故障域 |

下文使用以下 shell 变量。执行命令前必须替换示例值：

```sh
DSH_REPOSITORY_URL='ssh://git.example.com/ai/deepseek-harness.git'
DSH_RELEASE_REF='replace-with-tag-or-full-commit'
DSH_RELEASE_DIR="/opt/deepseek-harness/releases/${DSH_RELEASE_REF}"
```

不要把包含凭据的变量加入 shell history。本文只使用上述非敏感部署变量。

-----

## 第一阶段：准备 Linux 主机

本阶段创建运行账号、目录和基础依赖。以下包管理命令适用于 Ubuntu 或 Debian；其他发行版应使用等价的软件包，并在验收记录中填写实际版本。

### 1. 安装系统依赖

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential python3 bubblewrap
```

`bubblewrap` 是 Linux 上优先使用的本地命令隔离后端。项目也携带 Landlock 启动器作为 Linux 后备方案，但沙箱不能替代主机权限隔离。

### 2. 安装 Node.js 和 pnpm

通过公司批准的软件源安装系统级 Node.js。不要让 systemd 依赖交互式 shell 中的 `nvm` 初始化。

安装完成后执行：

```sh
node --version
command -v node
sudo corepack enable
sudo corepack prepare pnpm@11.7.0 --activate
pnpm --version
command -v pnpm
```

通过标准：

- Node.js 满足 `^22.19.0 || >=24.0.0`。
- pnpm 输出 `11.7.0`。
- `node` 和 `pnpm` 使用 systemd 可访问的绝对路径。

### 3. 创建低权限运行用户

先检查账号是否存在：

```sh
id dsh
```

只有在账号不存在时才创建：

```sh
sudo useradd --system --create-home --shell /bin/bash dsh
```

### 4. 创建目录

```sh
sudo mkdir -p /opt/deepseek-harness/releases
sudo mkdir -p /var/lib/deepseek-harness
sudo mkdir -p /srv/dsh-workspace
sudo mkdir -p /etc/deepseek-harness
sudo chown -R dsh:dsh /var/lib/deepseek-harness /srv/dsh-workspace
sudo chmod 700 /var/lib/deepseek-harness
sudo chmod 750 /srv/dsh-workspace
```

不要把工作区设置为 `/`、`/etc`、`/opt`、其他应用目录或包含公司大范围共享数据的目录。

### 5. 验证网络和时间

```sh
timedatectl status
getent hosts api.deepseek.com
curl --head --max-time 10 https://api.deepseek.com/
```

使用公司兼容 endpoint 时，把域名替换为实际地址。HTTP 状态可以不是 `200`，但 DNS、TLS 和 TCP 连接必须成功。系统时间必须正确，否则 TLS 和鉴权可能失败。

-----

## 第二阶段：安装并构建项目

应在目标 Linux 架构上安装依赖并构建。不要直接复制 macOS、Windows 或不同 CPU 架构上的 `node_modules` 和构建目录。

### 1. 获取固定发布版本

```sh
sudo git clone --branch "$DSH_RELEASE_REF" --depth 1 "$DSH_REPOSITORY_URL" "$DSH_RELEASE_DIR"
sudo chown -R dsh:dsh "$DSH_RELEASE_DIR"
```

如果发布身份是不能通过 `--branch` 获取的完整 commit，则先克隆仓库，再显式检出该 commit：

```sh
sudo git clone "$DSH_REPOSITORY_URL" "$DSH_RELEASE_DIR"
sudo chown -R dsh:dsh "$DSH_RELEASE_DIR"
sudo -u dsh git -C "$DSH_RELEASE_DIR" checkout --detach "$DSH_RELEASE_REF"
```

确认实际 commit：

```sh
sudo -u dsh git -C "$DSH_RELEASE_DIR" rev-parse HEAD
sudo -u dsh git -C "$DSH_RELEASE_DIR" status --short
```

`HEAD` 必须等于变更单记录的 commit，且 `status --short` 必须为空。

### 2. 安装锁定依赖

```sh
sudo -u dsh env CI=true pnpm --dir "$DSH_RELEASE_DIR" install --frozen-lockfile
```

如果公司网络使用 HTTP 代理，应通过受控的 systemd 或包管理器配置提供代理。支持该行为的 Node.js 版本可以在运行环境中设置 `NODE_USE_ENV_PROXY=1`，并通过 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 指定代理策略。

### 3. 构建完整产物

```sh
sudo -u dsh pnpm --dir "$DSH_RELEASE_DIR" run build
```

构建阶段可能使用约 4 GiB Node.js heap。主机内存不足时，构建可能被 OOM killer 终止；应增加构建主机资源或在同架构的受控构建环境生成发布目录。

### 4. 检查关键产物

```sh
sudo -u dsh test -f "$DSH_RELEASE_DIR/apps/cli/lib/bin.js"
sudo -u dsh test -f "$DSH_RELEASE_DIR/apps/web/dist/index.html"
```

两个命令都必须以状态 `0` 退出。

### 5. 发布 current 链接

```sh
sudo ln -sfn "$DSH_RELEASE_DIR" /opt/deepseek-harness/current
readlink -f /opt/deepseek-harness/current
```

输出必须等于本次发布目录。完成构建后，可以把发布目录改为 root 只写，防止运行进程修改程序文件：

```sh
sudo chown -R root:root "$DSH_RELEASE_DIR"
```

-----

## 第三阶段：配置运行数据和凭据

项目默认从 `DSH_HOME` 管理 Profile、设置、凭据、会话和其他持久状态。本手册固定使用 `/var/lib/deepseek-harness`，避免依赖服务用户的 home 目录。

### 1. 创建环境文件

```sh
sudo install -m 640 -o root -g dsh /dev/null /etc/deepseek-harness/dsh.env
sudoedit /etc/deepseek-harness/dsh.env
```

公共 DeepSeek API 示例：

```ini
DSH_HOME=/var/lib/deepseek-harness
DEEPSEEK_API_KEY=replace-with-secret
DSH_TELEMETRY_MODE=DISABLED
DSH_PERMISSION_MODE=workspace-write
NODE_ENV=production
```

公司内部兼容 endpoint 示例：

```ini
DSH_HOME=/var/lib/deepseek-harness
DEEPSEEK_API_KEY=replace-with-secret
DEEPSEEK_BASE_URL=https://llm-api.internal.example.com
DSH_TELEMETRY_MODE=DISABLED
DSH_PERMISSION_MODE=workspace-write
NODE_ENV=production
NODE_USE_ENV_PROXY=1
HTTPS_PROXY=http://proxy.internal.example.com:8080
NO_PROXY=127.0.0.1,localhost,.internal.example.com
```

环境文件使用 systemd `EnvironmentFile` 格式，不是完整 shell 脚本。不要使用 `export`、命令替换或 shell 函数。

### 2. 检查文件权限

```sh
sudo stat -c '%U %G %a %n' /etc/deepseek-harness/dsh.env
sudo stat -c '%U %G %a %n' /var/lib/deepseek-harness
sudo stat -c '%U %G %a %n' /srv/dsh-workspace
```

预期：

```text
root dsh 640 /etc/deepseek-harness/dsh.env
dsh dsh 700 /var/lib/deepseek-harness
dsh dsh 750 /srv/dsh-workspace
```

### 3. 凭据优先级

基础 Profile 的凭据来源按以下顺序解析：

1. 启动进程继承的环境变量。
2. `$DSH_HOME/.credentials.yaml`。
3. 启动工作区中的 `.env`。
4. `$DSH_HOME/.env`。

本手册通过 systemd 环境提供 `DEEPSEEK_API_KEY`。该值在本次进程中优先，并在 Web 设置页面中表现为只读来源。需要通过 Web UI 管理密钥时，应从 systemd 环境中删除该变量，再使用产品管理的 `$DSH_HOME/.credentials.yaml`。

### 4. 持久数据位置

默认基础 Profile 使用以下位置：

| 数据 | 默认位置 |
|---|---|
| Profile | `/var/lib/deepseek-harness/profiles` |
| Session 日志 | `/var/lib/deepseek-harness/sessions` |
| 持久 KV 数据 | `/var/lib/deepseek-harness/storages` |
| 用户设置 | `/var/lib/deepseek-harness/settings.yaml` |
| 产品管理的凭据 | `/var/lib/deepseek-harness/.credentials.yaml` |
| 用户 Agent preset | `/var/lib/deepseek-harness/.agent-presets` |

不要把 `/var/lib/deepseek-harness` 放在会自动清理的临时文件系统中。

-----

## 第四阶段：部署前冒烟验证

本阶段在安装 systemd 前验证 CLI、Profile 初始化、模型访问和 Web 启动。模型验证需要有效 API Key；没有密钥时只能执行无密钥检查，并在验收记录中标记模型验证待目标环境完成。

### 1. 检查 CLI 版本和帮助

```sh
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness \
  /usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js --version

sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness \
  /usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js web --help
```

如果 `command -v node` 不是 `/usr/bin/node`，后续命令和 systemd unit 必须使用实际绝对路径。

### 2. 检查默认组合配置

```sh
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness \
  /usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js \
  --profile web --dump-default-config >/tmp/dsh-web-default-config.yml

grep -n "host:.*127.0.0.1" /tmp/dsh-web-default-config.yml
grep -n "port:.*3080" /tmp/dsh-web-default-config.yml
```

该命令会自动初始化缺失的 `web` Profile 文件，但不会启动服务。默认配置必须显示 loopback 地址和端口 `3080`。

### 3. 执行模型冒烟测试

先把环境文件读入一个受控 root shell，再以 `dsh` 用户运行进程：

```sh
sudo bash -lc '
  set -a
  . /etc/deepseek-harness/dsh.env
  set +a
  cd /srv/dsh-workspace
  exec runuser -u dsh --preserve-environment -- \
    /usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js \
    --profile headless "只回复 DSH_DEPLOYMENT_OK"
'
```

通过标准：

- 进程退出码为 `0`。
- stdout 最终答案包含 `DSH_DEPLOYMENT_OK`。
- stderr 没有鉴权失败、模型不存在、DNS、TLS 或超时错误。

Headless 模式会把模型推理增量写入 stderr。不要把冒烟测试改成包含敏感业务信息的任务。

### 4. 手工启动 Web 服务

```sh
sudo bash -lc '
  set -a
  . /etc/deepseek-harness/dsh.env
  set +a
  cd /srv/dsh-workspace
  exec runuser -u dsh --preserve-environment -- \
    /usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js \
    web --no-open --host 127.0.0.1 --port 3080
'
```

看到 `dsh web:` URL 后，在另一个终端执行：

```sh
curl --fail --silent --show-error --head http://127.0.0.1:3080/
ss -lntp | grep '127.0.0.1:3080'
```

按 `Ctrl+C` 停止手工进程。服务应执行有界优雅关闭；第二次信号会强制立即退出。

-----

## 第五阶段：安装 systemd 服务

systemd 服务固定以 `dsh` 用户从 `/srv/dsh-workspace` 启动，因此该目录也是默认工作区和默认沙箱策略根目录。

### 1. 确认 Node.js 绝对路径

```sh
command -v node
```

下方 unit 使用 `/usr/bin/node`。如果实际路径不同，必须替换 `ExecStart`。

### 2. 创建 unit

```sh
sudoedit /etc/systemd/system/deepseek-harness.service
```

写入：

```ini
[Unit]
Description=DeepSeek Harness Web
Documentation=https://github.com/deepseek-ai/deepseek-harness
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh
Group=dsh
WorkingDirectory=/srv/dsh-workspace
EnvironmentFile=/etc/deepseek-harness/dsh.env

ExecStart=/usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js web --no-open --host 127.0.0.1 --port 3080

Restart=on-failure
RestartSec=5s
TimeoutStartSec=120s
TimeoutStopSec=15s
KillSignal=SIGTERM

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/deepseek-harness /srv/dsh-workspace

StandardOutput=journal
StandardError=journal
SyslogIdentifier=deepseek-harness

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` 让系统文件树对服务只读，`ReadWritePaths` 只重新开放 Harness 数据目录和 Agent 工作区。该 systemd 限制是主机级加固措施，与 Harness 的 Session 权限和命令沙箱共同工作。

### 3. 校验并启动

```sh
sudo systemd-analyze verify /etc/systemd/system/deepseek-harness.service
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-harness.service
sudo systemctl status --no-pager deepseek-harness.service
```

查看启动日志：

```sh
sudo journalctl -u deepseek-harness.service -n 100 --no-pager
```

日志中应出现 `dsh web:` URL。不要把完整含令牌 URL 复制到权限范围更大的日志系统。

### 4. 验证重启策略

```sh
sudo systemctl restart deepseek-harness.service
sudo systemctl is-active deepseek-harness.service
sudo systemctl is-enabled deepseek-harness.service
```

两个状态分别必须是 `active` 和 `enabled`。

-----

## 第六阶段：配置访问路径

选择 SSH 隧道或公司反向代理。SSH 隧道适合单人试运行和管理员访问；反向代理适合长期多人使用。

### 方案 A：SSH 隧道

在用户电脑执行：

```sh
ssh -N -L 3080:127.0.0.1:3080 <linux-user>@<linux-host>
```

从受控的服务日志中取得启动 URL，把 URL 的主机部分替换为 `127.0.0.1:3080`，保留路径和查询参数，然后在本地浏览器打开。完成首次令牌交换后，浏览器会保存签名会话 cookie 并跳转到干净根路径。

通过标准：

- 浏览器可以加载 Web UI。
- Linux 主机防火墙不需要开放 `3080`。
- `ss -lntp` 仍只显示 `127.0.0.1:3080`。

### 方案 B：Nginx 反向代理

反向代理必须部署公司 TLS 证书和身份认证。以下片段只展示代理要求，不包含公司身份认证配置：

```nginx
server {
    listen 443 ssl http2;
    server_name dsh.internal.example.com;

    ssl_certificate     /etc/nginx/tls/dsh.crt;
    ssl_certificate_key /etc/nginx/tls/dsh.key;

    # 在此处接入公司 SSO、OAuth2 Proxy、VPN 或零信任认证。

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

反向代理域名还必须加入 Web 的受信 authority。修改 systemd 的 `ExecStart`：

```ini
ExecStart=/usr/bin/node /opt/deepseek-harness/current/apps/cli/lib/bin.js web --no-open --host 127.0.0.1 --port 3080 --trusted-host dsh.internal.example.com
```

重新加载并重启：

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl daemon-reload
sudo systemctl restart deepseek-harness.service
```

使用反向代理后的首次启动 URL 时，把原 URL 的 scheme 和 authority 换成 `https://dsh.internal.example.com`，保留路径和查询参数。不要在没有 TLS 和公司认证的情况下开放该域名。

-----

## 部署后验收流程

验收应按本节顺序执行，并把命令、输出摘要、执行人和时间写入变更单。任何阻断项失败时停止上线。

### 1. 发布身份检查

```sh
readlink -f /opt/deepseek-harness/current
git -C /opt/deepseek-harness/current rev-parse HEAD
git -C /opt/deepseek-harness/current status --short
node --version
pnpm --version
```

通过标准：

- `current` 指向本次发布目录。
- `HEAD` 等于批准的 commit。
- 工作树为空。
- Node.js 和 pnpm 满足部署输入中的版本要求。

### 2. 服务状态检查

```sh
sudo systemctl is-active deepseek-harness.service
sudo systemctl is-enabled deepseek-harness.service
sudo systemctl show deepseek-harness.service \
  --property=User,Group,WorkingDirectory,MainPID,ExecMainStatus,NRestarts
```

通过标准：

- 服务状态为 `active`。
- 开机启动状态为 `enabled`。
- 用户和组均为 `dsh`。
- `WorkingDirectory` 为 `/srv/dsh-workspace`。
- `ExecMainStatus=0`，且服务没有持续重启。

### 3. 监听地址检查

```sh
sudo ss -lntp | grep ':3080'
```

通过标准：

- 只出现 `127.0.0.1:3080`。
- 不出现 `0.0.0.0:3080`、`[::]:3080` 或公司网卡地址。

这是阻断性安全检查。

### 4. HTTP 和静态资源检查

```sh
curl --fail --silent --show-error --head http://127.0.0.1:3080/
curl --fail --silent --show-error http://127.0.0.1:3080/ >/dev/null
```

通过标准：

- 请求成功，没有连接拒绝或 `5xx`。
- 服务日志没有前端产物缺失提示。

### 5. 访问控制检查

SSH 模式应确认未建立隧道的普通用户无法从网络直接访问 `3080`。反向代理模式应确认：

- 未认证请求被公司认证层拒绝。
- 已认证用户可以加载页面。
- HTTP 自动跳转到 HTTPS，或 HTTP 端口完全关闭。
- WebSocket 可以保持连接。
- 不受信 Host 或 Origin 请求被拒绝。

### 6. Web UI 功能检查

在浏览器中执行：

1. 使用启动 URL 完成首次登录。
2. 打开设置页，确认目标模型 route 可见。
3. 添加并选择 `/srv/dsh-workspace` 工作区。
4. 创建新会话。
5. 发送“只回复 `WEB_DEPLOYMENT_OK`”。
6. 确认最终回答包含 `WEB_DEPLOYMENT_OK`。
7. 刷新页面，确认会话仍在列表中。
8. 重新打开该会话，确认历史消息完整。

模型调用失败时，检查 API Key、endpoint、代理、CA 证书、模型 id 和系统时间。

### 7. 持久化检查

完成 Web 会话后执行：

```sh
sudo -u dsh find /var/lib/deepseek-harness/sessions -type f -print | head
sudo -u dsh find /var/lib/deepseek-harness/storages -type f -print | head
sudo du -sh /var/lib/deepseek-harness
```

至少应出现 Session 日志和持久状态文件。随后执行：

```sh
sudo systemctl restart deepseek-harness.service
```

重新访问 Web UI，确认重启前的会话仍可查看。该检查验证 `DSH_HOME` 没有错误指向临时目录。

### 8. 工作区写入检查

在 Web 会话中要求 Agent 在工作区创建一个无敏感内容的测试文件，例如 `deployment-smoke.txt`。完成后执行：

```sh
sudo -u dsh test -f /srv/dsh-workspace/deployment-smoke.txt
sudo -u dsh stat /srv/dsh-workspace/deployment-smoke.txt
```

确认文件由 `dsh` 用户持有。验收后删除该测试文件：

```sh
sudo -u dsh rm /srv/dsh-workspace/deployment-smoke.txt
```

### 9. 主机权限检查

直接验证服务账号不能修改系统目录：

```sh
sudo -u dsh touch /etc/dsh-permission-test
```

该命令必须失败，并且 `/etc/dsh-permission-test` 不得存在：

```sh
sudo test ! -e /etc/dsh-permission-test
```

还应在 Web 会话中请求一个工作区外写操作，确认产品按当前权限策略拒绝或请求审批。不要批准对真实系统文件的写操作。

### 10. 沙箱检查

```sh
bwrap --version
sudo journalctl -u deepseek-harness.service --since "10 minutes ago" --no-pager
```

确认日志中没有持续的沙箱探测失败、权限拒绝循环或子进程启动失败。即使 `bubblewrap` 可用，也必须保留独立低权限用户和 systemd 文件系统限制。

### 11. 遥测策略检查

```sh
sudo systemctl show deepseek-harness.service --property=EnvironmentFiles
sudo grep '^DSH_TELEMETRY_MODE=DISABLED$' /etc/deepseek-harness/dsh.env
```

公司策略要求关闭遥测时，该值必须存在。不要打印完整环境，因为其中含有 API Key。

### 12. 日志与敏感信息检查

```sh
sudo journalctl -u deepseek-harness.service -n 200 --no-pager
```

检查内容：

- 没有 API Key、代理密码或完整业务数据。
- 启动 URL 的读取权限符合公司要求。
- 没有持续重启、未处理异常或数据库/文件权限错误。
- 没有把模型推理日志转发到权限范围过大的中央日志系统。

### 13. 优雅停止和开机恢复检查

```sh
sudo systemctl stop deepseek-harness.service
sudo systemctl is-active deepseek-harness.service
sudo systemctl start deepseek-harness.service
sudo systemctl is-active deepseek-harness.service
```

停止后状态应为 `inactive`，重新启动后应为 `active`。允许维护窗口重启主机时，再执行一次主机重启验证：

```sh
sudo reboot
```

主机恢复后检查：

```sh
sudo systemctl is-active deepseek-harness.service
curl --fail --silent --show-error --head http://127.0.0.1:3080/
```

### 14. 验收结论

以下项目均通过后才可批准上线：

- 发布身份正确。
- 服务稳定运行且自动启动。
- 端口只监听 loopback。
- 公司访问控制生效。
- Web UI 和模型调用成功。
- Session 在服务重启后仍存在。
- 工作区内写入成功，系统目录写入失败。
- 遥测、日志和凭据策略符合公司要求。
- 备份任务已经配置，并完成至少一次恢复演练。

-----

## 备份与恢复

备份必须覆盖完整的 `/var/lib/deepseek-harness`，并单独保护 `/etc/deepseek-harness/dsh.env`。发布代码不需要作为状态备份，但必须能够通过已记录的 commit 或 tag 重新获取。

### 创建一致性备份

最安全的备份流程是在短维护窗口中停止服务：

```sh
sudo systemctl stop deepseek-harness.service
sudo tar --numeric-owner -C /var/lib -czf /var/backups/deepseek-harness-state-YYYYMMDD-HHMMSS.tar.gz deepseek-harness
sudo systemctl start deepseek-harness.service
```

把备份复制到独立故障域，并按公司策略加密。环境文件应进入公司密钥管理或受控配置备份，不应和普通 Session 归档使用相同访问权限。

### 验证备份

```sh
sudo tar -tzf /var/backups/deepseek-harness-state-YYYYMMDD-HHMMSS.tar.gz | head
sha256sum /var/backups/deepseek-harness-state-YYYYMMDD-HHMMSS.tar.gz
```

仅生成归档不算完成备份。上线前至少在隔离目录或测试主机完成一次恢复演练。

### 恢复状态

恢复前必须停止服务，并确认恢复数据对应的应用版本：

```sh
sudo systemctl stop deepseek-harness.service
sudo mv /var/lib/deepseek-harness /var/lib/deepseek-harness.before-restore
sudo mkdir -p /var/lib/deepseek-harness
sudo tar --numeric-owner -C /var/lib -xzf /var/backups/deepseek-harness-state-YYYYMMDD-HHMMSS.tar.gz
sudo chown -R dsh:dsh /var/lib/deepseek-harness
sudo chmod 700 /var/lib/deepseek-harness
sudo systemctl start deepseek-harness.service
```

恢复后重复服务、HTTP、Web UI 和持久化验收。确认恢复成功前不要删除 `deepseek-harness.before-restore`。

-----

## 版本升级

升级使用新的不可变 release 目录，不覆盖当前 release。预发布项目可能更改磁盘格式，因此升级前必须创建可恢复的状态备份。

### 1. 准备新版本

```sh
DSH_NEW_RELEASE_REF='replace-with-new-tag-or-commit'
DSH_NEW_RELEASE_DIR="/opt/deepseek-harness/releases/${DSH_NEW_RELEASE_REF}"

sudo git clone --branch "$DSH_NEW_RELEASE_REF" --depth 1 "$DSH_REPOSITORY_URL" "$DSH_NEW_RELEASE_DIR"
sudo chown -R dsh:dsh "$DSH_NEW_RELEASE_DIR"
sudo -u dsh env CI=true pnpm --dir "$DSH_NEW_RELEASE_DIR" install --frozen-lockfile
sudo -u dsh pnpm --dir "$DSH_NEW_RELEASE_DIR" run build
sudo -u dsh test -f "$DSH_NEW_RELEASE_DIR/apps/cli/lib/bin.js"
sudo -u dsh test -f "$DSH_NEW_RELEASE_DIR/apps/web/dist/index.html"
sudo chown -R root:root "$DSH_NEW_RELEASE_DIR"
```

### 2. 备份并切换

```sh
sudo systemctl stop deepseek-harness.service
sudo tar --numeric-owner -C /var/lib -czf /var/backups/deepseek-harness-pre-upgrade-YYYYMMDD-HHMMSS.tar.gz deepseek-harness
sudo ln -sfn "$DSH_NEW_RELEASE_DIR" /opt/deepseek-harness/current
sudo systemctl start deepseek-harness.service
```

### 3. 执行升级验收

至少重复以下检查：

- 发布身份。
- systemd 状态和重启次数。
- loopback 监听。
- HTTP 和 WebSocket。
- 模型调用。
- 历史 Session 加载。
- 新 Session 创建和持久化。
- 工作区读写和系统目录拒绝。

不要在验收完成前删除旧 release 和升级前备份。

-----

## 版本回滚

代码回滚和数据回滚必须一起评估。新版本一旦写入了旧版本不能读取的数据格式，仅切换 `current` 链接可能无法恢复服务。

### 1. 停止服务

```sh
sudo systemctl stop deepseek-harness.service
```

### 2. 恢复旧代码

```sh
sudo ln -sfn /opt/deepseek-harness/releases/<previous-release-ref> /opt/deepseek-harness/current
```

### 3. 必要时恢复升级前数据

```sh
sudo mv /var/lib/deepseek-harness /var/lib/deepseek-harness.failed-upgrade
sudo tar --numeric-owner -C /var/lib -xzf /var/backups/deepseek-harness-pre-upgrade-YYYYMMDD-HHMMSS.tar.gz
sudo chown -R dsh:dsh /var/lib/deepseek-harness
sudo chmod 700 /var/lib/deepseek-harness
```

### 4. 启动并验收

```sh
sudo systemctl start deepseek-harness.service
sudo systemctl status --no-pager deepseek-harness.service
curl --fail --silent --show-error --head http://127.0.0.1:3080/
```

回滚后重复模型、Session 和工作区验证。保留失败升级的数据副本，直到故障分析完成。

-----

## 日常运维

### 查看状态

```sh
sudo systemctl status --no-pager deepseek-harness.service
sudo systemctl show deepseek-harness.service --property=MainPID,NRestarts,MemoryCurrent,TasksCurrent
```

### 查看日志

```sh
sudo journalctl -u deepseek-harness.service -f
sudo journalctl -u deepseek-harness.service --since today --no-pager
```

### 重启服务

```sh
sudo systemctl restart deepseek-harness.service
```

### 查看磁盘增长

```sh
sudo du -sh /var/lib/deepseek-harness
sudo du -sh /var/lib/deepseek-harness/sessions /var/lib/deepseek-harness/storages
sudo df -h /var/lib/deepseek-harness /srv/dsh-workspace
```

### 修改模型凭据

编辑环境文件后必须重启进程，因为启动环境在进程启动时固定：

```sh
sudoedit /etc/deepseek-harness/dsh.env
sudo systemctl restart deepseek-harness.service
```

如果使用 Web UI 写入的 `.credentials.yaml`，凭据提供方会监视该文件，新值可以在后续请求中生效。

### 清理旧 release

只删除已经退出保留窗口、不是 `current` 目标且不再需要回滚的 release。删除前检查：

```sh
readlink -f /opt/deepseek-harness/current
sudo find /opt/deepseek-harness/releases -mindepth 1 -maxdepth 1 -type d -print
```

清理属于破坏性操作，应由公司发布保留策略和变更单明确授权。

-----

## 故障排查

### 服务启动后立即退出

```sh
sudo systemctl status --no-pager deepseek-harness.service
sudo journalctl -u deepseek-harness.service -n 200 --no-pager
```

重点检查：Node 路径错误、构建产物缺失、环境文件语法错误、`DSH_HOME` 权限错误、端口占用和 Profile 配置错误。

### 提示前端未构建

在当前 release 重新执行：

```sh
sudo -u dsh pnpm --dir /opt/deepseek-harness/current run build
sudo -u dsh test -f /opt/deepseek-harness/current/apps/web/dist/index.html
```

如果 release 已经设为 root 只写，应构建一个新的 release 目录，不要原地修改已发布版本。

### API Key 无效或模型请求失败

检查环境文件中变量名是否正确，但不要把值输出到终端：

```sh
sudo grep -E '^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)=' /etc/deepseek-harness/dsh.env | sed 's/=.*/=<redacted>/'
```

然后检查 endpoint、代理、CA、DNS、系统时间和模型 route。环境文件变化后必须重启服务。

### 浏览器无法连接

按顺序检查：

```sh
sudo systemctl is-active deepseek-harness.service
sudo ss -lntp | grep ':3080'
curl --fail --silent --show-error --head http://127.0.0.1:3080/
```

SSH 模式还要检查隧道是否存活。反向代理模式还要检查 Nginx 配置、TLS、认证层、WebSocket headers 和 `--trusted-host`。

### 返回 Host 或 Origin 拒绝

确认用户访问的 authority 与 systemd `ExecStart` 中的 `--trusted-host` 一致。修改 unit 后执行：

```sh
sudo systemctl daemon-reload
sudo systemctl restart deepseek-harness.service
```

不要通过关闭 Host/Origin 检查解决该问题。

### 端口被占用

```sh
sudo ss -lntp | grep ':3080'
sudo lsof -nP -iTCP:3080 -sTCP:LISTEN
```

停止冲突服务或选择新的 loopback 端口，并同步更新 systemd、SSH 隧道和反向代理配置。

### Session 重启后消失

检查服务实际环境和目录权限：

```sh
sudo systemctl show deepseek-harness.service --property=EnvironmentFiles,WorkingDirectory
sudo stat -c '%U %G %a %n' /var/lib/deepseek-harness
sudo find /var/lib/deepseek-harness/sessions -type f -print | head
```

常见原因是 `DSH_HOME` 未加载、指向临时目录、目录不可写或服务使用了另一套运行用户。

### systemd 加固导致启动失败

查看日志确认具体被拒绝的路径。只把业务确实需要写入的绝对目录加入 `ReadWritePaths`，不要移除全部文件系统保护。需要访问额外项目时，应建立单独受控工作区并由安全评审批准。

### 沙箱不可用

```sh
bwrap --version
uname -a
sudo journalctl -u deepseek-harness.service -n 200 --no-pager
```

某些内核或容器平台会限制 user namespace 或 mount namespace。修复平台能力或使用项目提供的 Linux 后备隔离机制；不要因为沙箱故障而把服务改为 root 或默认 `danger-full-access`。

-----

## 上线验收记录模板

把以下模板复制到公司变更单并填写。不要粘贴 API Key 或完整启动令牌。

```text
部署日期：
执行人：
复核人：
主机名：
Linux 发行版与版本：
CPU 架构：
发布 tag/commit：
Node.js 版本：
pnpm 版本：
DSH_HOME：/var/lib/deepseek-harness
工作区：/srv/dsh-workspace
访问方式：SSH 隧道 / 公司反向代理
访问域名（如适用）：
备份位置：

[ ] current 指向批准的 release
[ ] Git commit 与变更单一致
[ ] Git 工作树为空
[ ] systemd active 且 enabled
[ ] 服务以 dsh 用户运行
[ ] 只监听 127.0.0.1
[ ] HTTP 首页可访问
[ ] 公司认证生效
[ ] WebSocket 正常
[ ] 模型冒烟测试通过
[ ] Web 会话创建和回复正常
[ ] 服务重启后 Session 仍存在
[ ] 工作区内写入成功
[ ] 系统目录写入失败
[ ] 遥测策略已确认
[ ] 日志未发现凭据泄漏
[ ] 状态备份已生成
[ ] 恢复演练已通过
[ ] 回滚 release 和数据备份可用

异常与豁免：
最终结论：通过 / 不通过
```

-----

## 相关资料

- [项目安全声明](SAFETY.md)说明 developer preview、安全风险和最小权限要求。
- [CLI 行为参考](apps/cli/reference/README.md)说明 Profile、Web 参数、持久目录、关闭行为和部署默认值。
- [Web application bundle](packages/bundle/web-app/README.md)说明 Web 启动、令牌交换、受信 Host 和 SSH 行为。
- [Headless bundle](packages/bundle/headless/README.md)说明无界面模型冒烟测试的输出和退出码。
- [本地凭据提供方](packages/credentials/credentials-local/README.md)说明环境变量、托管凭据和 `.env` 的优先级。
- [Session JSONL 持久化](packages/session/session-persistence-jsonl/README.md)说明默认 Session 文件和恢复边界。

## 开发说明

本文档中的无密钥 CLI 帮助与默认配置命令已在当前仓库检出上执行。完整 Linux 安装、systemd、模型调用、SSH、Nginx、备份和恢复命令必须由部署人员在目标公司 Linux 环境中执行并记录，因为这些操作依赖目标主机、网络、密钥、代理、证书和权限策略。
