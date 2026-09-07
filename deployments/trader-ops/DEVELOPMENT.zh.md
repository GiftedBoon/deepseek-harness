# 本地开发步骤

[English](DEVELOPMENT.md) | 中文

## 1. 准备环境

需要 Node.js 22.19 及以上的 22.x，或 Node.js 24 及以上版本；同时需要 pnpm、Docker 和 Docker Compose。先在仓库根目录安装依赖：

```bash
pnpm install
```

在 Apple Silicon 开发机上，安装适用于 Apple 芯片的当前 Docker Desktop，打开 `/Applications/Docker.app` 并完成首次特权设置。确保用户级 CLI 目录已加入 `PATH`（`$HOME/.docker/bin`），再验证 daemon 和 ARM64 容器路径：

```bash
docker version
docker compose version
docker run --rm hello-world
```

不要关闭 Gatekeeper，也不要移除 Docker 的 quarantine 元数据。如果 Docker Desktop 为特权网络或 `/usr/local/bin` 链接请求管理员授权，应由用户在界面中完成；仓库脚本不能自动提交密码或接受许可协议。

从模板创建一个不纳入 Git 的本地环境文件，并把持久化目录改为当前用户可写的位置：

```bash
cp deployments/trader-ops/.env.example deployments/trader-ops/.env
chmod 600 deployments/trader-ops/.env
```

至少替换 `OPENVIKING_HOME`、`DSH_HOME` 和 `OPENVIKING_API_KEY`。加载变量：

```bash
set -a
source deployments/trader-ops/.env
set +a
```

## 2. 初始化并启动 OpenViking

首次启动容器后，官方入口会等待配置完成。另开一个终端运行初始化向导，为 OpenViking 配置可用的 VLM、embedding 模型以及 `server.root_api_key`：

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml up -d

docker exec -it trader-ops-openviking openviking-server init
```

模型提供方、模型名和密钥与实际环境有关，不能在仓库模板中伪造。初始化完成后重启并检查服务：

```bash
docker restart trader-ops-openviking
curl --fail http://127.0.0.1:1933/health
curl --fail http://127.0.0.1:1933/ready
```

本地调试界面位于 `http://127.0.0.1:1933/studio`。

## 3. 安装 DSH 插件并验证 Profile

引导脚本把 `@openviking/dsh-memory-plugin@0.3.0` 安装到 `web` Profile，并验证最终配置中同时存在 OpenViking、Trader Ops 工具策略和 skill 提供方：

```bash
deployments/trader-ops/scripts/bootstrap-profile.sh
deployments/trader-ops/scripts/verify-deployment.sh
```

当前插件版本要求 DSH 0.1.x 的相关包至少为 `0.1.0-rc.6`，并低于 `0.2.0`；本仓库 `0.1.3-alpha.1` 落在该范围内。升级 Harness 或插件时，应重新检查对等依赖（peer dependency）范围，并再次运行配置装配验证。

隔离的 Profile 安装目前会把这三个由 DSH 宿主提供、而非由 Profile 包提供的 DSH 包报告为缺失的对等依赖。只有宿主版本满足范围且 `--dump-config` 成功时，观测到的安装才可接受；任何额外的 peer 警告都必须调查。

## 4. 启动 Harness

```bash
pnpm dsh web \
  --patch deployments/trader-ops/config/dsh/trader-ops.patch.yml
```

没有业务知识和 `SKILL.md` 时，服务仍应正常启动：Trader Ops skill 数量为 0，OpenViking 只提供空的检索/记忆基线。这是预期状态。

## 5. 后续添加内容

- 在 `knowledge/business`、`knowledge/systems` 或 `knowledge/runbooks` 添加评审后的 Markdown，再通过明确的入库流程提交给 OpenViking。不要把 `README.md` 和 `README.zh.md` 纳入索引。
- 在某个 `skills/<name>/` 中添加完整 `SKILL.md`。Loader 只将直接子目录识别为 skill bundle，不要再嵌套业务分类层。
- 业务 MCP 服务可用后，复制并审查 `config/dsh/trader-ops-mcp.patch.yml.example`，去掉 `.example`，再作为第二个 `--patch` 参数加载。
- 新增工具时同步更新 `policies/tool-access.yaml`。Harness 侧插件已经按首条匹配和默认拒绝执行它；在可信身份与审批存储存在前，`risk-levels.yaml` 和 `approvals.yaml` 仍是设计约定。

## 6. 停止本地服务

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml down
```

该命令不会删除 `OPENVIKING_HOME` 中的持久化数据。
