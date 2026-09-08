# 本地开发步骤

[English](DEVELOPMENT.md) | 中文

## 1. 准备环境

需要 Node.js 22.19 及以上的 22.x，或 Node.js 24 及以上版本；同时需要 pnpm、Docker、Docker Compose、Homebrew 和 Ollama。先在仓库根目录安装依赖：

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

把两个持久化目录替换为宿主机绝对路径，把 `OPENVIKING_ROOT_API_KEY` 替换为随机秘密，并为无外部 key 的本地模型路径设置 `TRADER_OPS_LOCAL_LLM_ENABLED=true`。在 OpenViking 创建租户用户前，将 `OPENVIKING_API_KEY` 留空。加载变量：

```bash
set -a
source deployments/trader-ops/.env
set +a
```

## 2. 启动本地推理与 OpenViking

在 macOS 宿主机运行 Ollama，让推理使用 Apple Metal。保留默认的回环监听；OpenViking 容器通过 Docker Desktop 提供的 `host.docker.internal` 访问它：

```bash
brew install ollama
brew services start ollama
ollama pull qwen3-embedding:0.6b
ollama pull qwen3.5:4b
ollama pull guoxuter/ov_intent_analysis_sft:v7_q8
curl --fail http://127.0.0.1:11434/api/tags
```

把经过评审的本地配置安装到 OpenViking 持久化目录，再启动容器：

```bash
install -d "$OPENVIKING_HOME"
install -m 600 deployments/trader-ops/config/openviking/ov.conf.local-macos.example \
  "$OPENVIKING_HOME/ov.conf"
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml up -d
```

Root key 只用于账户管理。创建 root CLI 配置和租户管理员，把返回的 user key 写入权限为 `0600` 的 `.env` 中的 `OPENVIKING_API_KEY`，然后重新加载环境并激活用户级 CLI 配置：

```bash
docker exec trader-ops-openviking ov language en
docker exec trader-ops-openviking ov config add custom \
  --name trader-ops-root --url http://127.0.0.1:1933 \
  --root-api-key-env OPENVIKING_ROOT_API_KEY \
  --account trader-ops --user local-dev --activate --force
docker exec trader-ops-openviking ov admin create-account trader-ops \
  --admin local-dev --sudo

set -a
source deployments/trader-ops/.env
set +a
printf '%s' "$OPENVIKING_API_KEY" | docker exec -i trader-ops-openviking \
  ov config add custom --name trader-ops-local \
  --url http://127.0.0.1:1933 --api-key-stdin \
  --account trader-ops --user local-dev --activate --force
```

一起检查模型、身份验证、存储和 HTTP 路径：

```bash
docker exec trader-ops-openviking ov doctor
curl --fail http://127.0.0.1:1933/health
curl --fail http://127.0.0.1:1933/ready
```

本地调试界面位于 `http://127.0.0.1:1933/studio`。不要把 root key 提供给 Harness；如果某个 key 出现在终端截图或日志中，应立即轮换。

## 3. 安装 DSH 插件并验证 Profile

引导脚本把 `@openviking/dsh-memory-plugin@0.3.0` 安装到 `web` Profile，并验证最终配置中同时存在 OpenViking、Trader Ops 工具策略和 skill 提供方：

```bash
deployments/trader-ops/scripts/bootstrap-profile.sh
deployments/trader-ops/scripts/verify-deployment.sh
```

当前插件版本要求 DSH 0.1.x 的相关包至少为 `0.1.0-rc.6`，并低于 `0.2.0`；本仓库 `0.1.3-alpha.1` 落在该范围内。升级 Harness 或插件时，应重新检查对等依赖（peer dependency）范围，并再次运行配置装配验证。

隔离的 Profile 安装目前会把这三个由 DSH 宿主提供、而非由 Profile 包提供的 DSH 包报告为缺失的对等依赖。只有宿主版本满足范围且 `--dump-config` 成功时，观测到的安装才可接受；任何额外的 peer 警告都必须调查。

启动 Web 应用前先构建源码检出：

```bash
pnpm run build
```

如果 `fs-ext` 报告缺少原生二进制，并且 Apple Command Line Tools 找不到 C++ `<memory>` 头文件，只重建该依赖并显式提供 SDK include 目录：

```bash
CPLUS_INCLUDE_PATH=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1 \
  pnpm --filter @deepseek-ai/dsh-session-persistence-jsonl rebuild fs-ext
```

## 4. 启动 Harness

```bash
pnpm dsh web \
  --patch deployments/trader-ops/config/dsh/trader-ops.patch.yml \
  --patch deployments/trader-ops/config/dsh/trader-ops-local-ollama.patch.yml \
  --no-open
```

第二个 patch 通过受支持的 `llm-pi-ai` OpenAI-compatible 路由声明 Ollama，并把 `qwen3.5:4b` 设为本地默认模型。它的 `ollama-local` API key 值只是非秘密的适配器占位符，Ollama 会忽略它。测试常规 DeepSeek 模型路径时，应省略这个 patch，并配置经过评审的提供方凭据。

该命令会输出本地访问 URL 与 token。没有业务知识和 `SKILL.md` 时，服务仍应正常启动：Trader Ops skill 数量为 0，OpenViking 只提供空的检索/记忆基线。这是预期状态。首次本地回合加载模型时可能需要约一分钟。

## 5. 后续添加内容

- 在 `knowledge/business`、`knowledge/systems` 或 `knowledge/runbooks` 添加评审后的非空 Markdown，再通过明确的入库流程提交给 OpenViking。不要把 `README.md`、`README.zh.md` 和空白或只含空白字符的文件纳入索引；否则 OpenViking 可能仅根据文件名派生出误导性的语义元数据。
- 在某个 `skills/<name>/` 中添加完整 `SKILL.md`。Loader 只将直接子目录识别为 skill bundle，不要再嵌套业务分类层。
- 业务 MCP 服务可用后，复制并审查 `config/dsh/trader-ops-mcp.patch.yml.example`，去掉 `.example`，再作为第二个 `--patch` 参数加载。
- 新增工具时同步更新 `policies/tool-access.yaml`。Harness 侧插件已经按首条匹配和默认拒绝执行它；在可信身份与审批存储存在前，`risk-levels.yaml` 和 `approvals.yaml` 仍是设计约定。

## 6. 停止本地服务

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml down
```

该命令不会删除 `OPENVIKING_HOME` 中的持久化数据。
