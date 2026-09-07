# 远程部署步骤

[English](DEPLOYMENT.md) | 中文

以下流程假设一台受控 Linux 主机运行 Harness 与 OpenViking，外部流量由现有反向代理接入。若拆分到不同主机，应保持相同的密钥管理和私网边界，并把 `OPENVIKING_URL` 指向受 TLS 保护的内部地址。

## 目录约定

```text
/opt/deepseek-harness/releases/<git-ref>/  # 不可变发布目录
/opt/deepseek-harness/current              # 指向当前发布的符号链接
/etc/deepseek-harness/trader-ops.env       # 0600，部署密钥与环境差异
/var/lib/deepseek-harness/                 # DSH Profile 与运行状态
/var/lib/openviking/                       # ov.conf、向量数据与运行数据
/srv/dsh-workspace/                        # Agent 被允许访问的工作目录
```

建议创建专用 `dsh` 用户和组，并只把以上运行目录授权给它。发布目录由部署系统写入，运行用户只读。

## 首次部署

1. 将已评审的 Git revision 解包到新的 release 目录，在该目录运行 `pnpm install --frozen-lockfile` 和项目构建命令，再原子更新 `current` 链接。
2. 从 `.env.example` 生成 `/etc/deepseek-harness/trader-ops.env`，权限设为 `0600`。替换所有占位值；生产环境将 `OPENVIKING_IMAGE` 固定为已验证的 tag 或 digest。
3. 使用部署环境文件启动 OpenViking：

   ```bash
   docker compose --env-file /etc/deepseek-harness/trader-ops.env \
     -f /opt/deepseek-harness/current/deployments/trader-ops/config/openviking/docker-compose.yml up -d
   docker exec -it trader-ops-openviking openviking-server init
   docker restart trader-ops-openviking
   ```

4. 在初始化向导中配置真实 VLM、embedding 模型和 `server.root_api_key`。环境文件中的 `OPENVIKING_API_KEY` 必须与该 root key 一致。
5. 加载环境文件并安装固定版本的 DSH 插件：

   ```bash
   set -a
   source /etc/deepseek-harness/trader-ops.env
   set +a
   /opt/deepseek-harness/current/deployments/trader-ops/scripts/bootstrap-profile.sh
   /opt/deepseek-harness/current/deployments/trader-ops/scripts/verify-deployment.sh
   ```

6. 将 `config/systemd/dsh-trader-ops.service` 安装到 `/etc/systemd/system/`，确认 `pnpm` 路径、用户、工作目录和 `ReadWritePaths` 符合主机实际布局，然后启用服务。
7. 只通过反向代理暴露 Harness；OpenViking Compose 默认绑定回环地址。配置 TLS、身份认证、访问日志和请求大小/超时上限。

## 每次发布

1. 构建新的不可变 release，不覆盖正在运行的目录。
2. 在临时 `DSH_HOME` 上运行 `bootstrap-profile.sh` 和 `--dump-config`，确认插件依赖与 patch 仍可组合。
3. 备份 `/var/lib/openviking` 和 `/var/lib/deepseek-harness`，再执行需要的数据迁移。
4. 更新 `current` 链接，重新运行正式 `DSH_HOME` 的引导脚本，然后重启 systemd 服务。
5. 运行 `verify-deployment.sh`，再做只读检索和空 skill catalog 的冒烟测试。
6. 失败时把 `current` 链接切回上一已验证 release，并恢复与该版本匹配的数据备份；不要直接删除持久化目录。

## 上线前门禁

- OpenViking `/health` 与 `/ready` 均成功，且持久化目录在容器重启后保持数据。
- `dsh --dump-config` 中只有一个预期的 `openviking-memory-runtime`，并包含 `trader-ops-tool-policy` 与 `trader-ops-skills`。
- 实际环境未使用模板占位密钥，密钥不会出现在 Git、日志或进程参数中。
- 反向代理、主机防火墙和服务监听地址经过检查。
- `tool-access.yaml` 必须以 `enforced: true`、显式 `TRADER_OPS_ENVIRONMENT` 和默认拒绝加载。在业务 MCP 服务重复执行主体、资源与参数级授权前，仍只允许可信开发者访问。
- 启用 Trader Ops MCP 前，逐项审查工具 schema、身份传递、超时、重试、幂等性和审计记录。

## 备份与监控

备份至少覆盖 `/var/lib/openviking`、`/var/lib/deepseek-harness` 和外部审批/审计存储。监控应包含 OpenViking 健康/就绪端点、Harness 进程、插件连接失败、检索延迟、MCP 工具失败率和磁盘容量。任何自动恢复都不应重放非幂等的业务写操作。
