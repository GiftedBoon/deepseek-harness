# Trader Ops Agent 部署资源

[English](README.md) | 中文

本目录保存 Trader Ops 团队部署 DeepSeek Harness 时使用的业务知识、可执行 Skill 和治理策略。它们可以一起由 Git 管理，但由不同的运行时组件加载，不能互相替代。

```text
deployments/trader-ops/
├── config/       # DSH, OpenViking, and systemd configuration
├── knowledge/    # Facts, rules, and operational context indexed by OpenViking
├── policies/     # Enforced tool access plus future identity/approval contracts
├── remote-deployment/ # Validated remote deployment record
├── scripts/      # Profile bootstrap and deployment verification scripts
├── skills/       # Task instructions loaded in full by Harness Skill Loader
├── templates/    # Obsidian authoring templates excluded from knowledge ingestion
├── ARCHITECTURE.md
├── DEVELOPMENT.md
└── DEPLOYMENT.md
```

当前骨架支持知识文档和 `SKILL.md` 都为零的状态。先阅读[架构说明](ARCHITECTURE.md)，然后按[本地开发步骤](DEVELOPMENT.md)或[远程部署步骤](DEPLOYMENT.md)操作。

当前远程验证快照位于[remote-deployment/](remote-deployment/README.zh.md)。其中记录已部署 revision、服务入口、健康检查和企业微信 Session 重建验收顺序，不保存凭据或消息内容。

## 应该放在这里

- 团队共享、需要评审和版本追踪的 Agent 运行资料。
- 与业务知识、任务执行流程或安全治理直接相关的 Markdown、YAML 及 Skill 配套资源。
- 不含密钥、令牌和个人信息的示例配置。

## 不应该放在这里

- MCP Server、数据库客户端或 SSH 执行器的实现代码；它们应放在对应 package 或 integration 中。
- 数据库实时记录、监控快照和不断变化的运行状态；Agent 应通过 MCP 或 API 实时读取。
- API key、密码、私钥、生产连接串等秘密。
- Harness 核心源码或与 Trader Ops 团队部署无关的项目文档。

## 加载关系

Profile 引导为 OpenViking `0.3.0` 应用经过检查的兼容补丁：记忆消息使用与已迁移历史一致的生产者来源类型，画像和召回识别也使用该类型，采集仅接受用户、模型或工具消息。合成上下文不会作为用户输入保存。部署验证会拒绝缺少补丁的安装；包版本不同或检查过的源码发生变化时，引导停止且不会改写 Session 历史。

画像识别读取当前派生的消息历史。画像仍在模型上下文中时，不会再次进行启动注入；被压缩移除的画像可以重新获取。

`bootstrap-profile.sh` 将经审阅的企业微信组装写成 `preset.cordis.yml` 中的 `dsh-agent-preset` 声明。部署 provider 会在 Host 依赖可用后验证并注册声明；企业微信渠道依赖该 provider 的就绪服务。移除 provider 会停止渠道。`verify-deployment.sh` 将声明的 `config.plugins` 与经审阅的 Agent 组装比较，不计入 Host 侧的 preset 注册。Schedule 从可选的 `schedule-bundle` patch 加载；即使目标 Session 未处于 live 状态，也会通过 Host 投递到期 prompt。

```text
knowledge/*.md  ----submit/sync---> OpenViking ----retrieved fragments---> Agent context
skills/*/SKILL.md ----------------> Harness Skill Loader ----full content---> Agent
policies/*.yaml ------------------> Policy / Hook / Tool Guard ----allow, approve, or deny---> Tool
```

`deployments/trader-ops/skills` 不是文件系统 Skill Provider 的默认目录。`config/dsh/trader-ops.patch.yml` 通过独立提供方把它加入 `customSkillDirs`：

```yaml
- insert:
    - id: trader-ops-skills
      name: '@deepseek-ai/dsh-skill-filesystem'
      config:
        providerName: trader-ops
        includeDefaultRoots: false
        customSkillDirs:
          - ./deployments/trader-ops/skills
```

知识同步可以独立配置，例如：

```yaml
knowledge:
  source: ./deployments/trader-ops/knowledge
  provider: openviking
  include: "**/*.md"
  exclude:
    - "**/README.md"
    - "**/README.zh.md"
```

以上知识同步配置是待实现的入库约定，不代表 Harness 或 OpenViking 当前内置的配置字段。OpenViking DSH 插件不会自动扫描 Git 目录；实际接入器应把 `knowledge` 当作可检索资料，把 `skills` 和 `policies` 排除在知识索引之外。

`tool-access.yaml` 已由 DSH patch 中的实验策略插件加载，并对未匹配工具失败关闭。`risk-levels.yaml` 和 `approvals.yaml` 仍是设计约定；可信身份、资源授权、持久审批与完整审计必须在业务 MCP 服务边界实现。

## 预开启自动守护

Agent 在接收报告的企业微信会话中按 [preopen-watch](skills/preopen-watch/SKILL.md) 创建执行型 Schedule 任务。加载 Skill 不会自动安排任务。`schedule_task_create` 执行保存的指令；`schedule_create` 仍是提醒。现有智能机器人通过原会话的持久发送队列回传定时结果，不需要 webhook 或另一个机器人。任务路由使用创建任务的会话，不使用 `TRADER_OPS_PREOPEN_CHAT_ID`。

每日入口按 `Asia/Shanghai` 的 23:40 执行，通过交易日历核验下一自然日。星期日晚上可检查星期一；星期五晚上不会跳到星期一。估算日历或日历查询失败不能授权生产检测。Agent 创建每 60 秒、目标日 00:30 过期的当夜复查，以及不设过期时间的独立截止任务，记录真实任务编号并回读配置。每次执行先核验持久完成标志，已排队的迟到 tick 不会重新开启已结束夜晚。服务中断或 Agent 繁忙可能延迟执行；服务必须保持运行。

Skill 负责完成判据、停滞只读排查、输出限制与证据处理。上一批比对成功且缺失为零时省略说明。连续三次新鲜、完整且待开启集合不变的有效检查触发排查；旧批次或重复读取同一批次不增加次数。保存进程检查 `run_id` 后继续轮询，不重新派发，每台 colo 分别保存证据。缺日期或时区不明确的日志不能证实当夜启动故障。截止时未完成夜晚均报告，即使整夜没有有效批次；全部自动业务操作保持只读。

流程状态通过当前会话有界的 `schedule_state_read` 与比较后写入（compare-and-swap）的 `schedule_state_write` 工具保存，包含配置、当前目标日、任务编号、完成标志、监控汇总及最小取证摘要，不包含原始日志或凭据。Schedule 执行记录与机器人发送记录分别保存：Agent 完成不能证明企业微信已送达。无需播报的检查不产生最终文本；渠道不会为定时执行发送空回复提示。

[bssh MCP patch](config/dsh/trader-ops-bssh-ops-mcp.patch.yml) 在 `TRADER_OPS_PREOPEN_WATCH_ENABLED=1` 时仍保留[旧守护](scripts/preopen-watch-plugin.mjs)，供受控切换使用；验收前保留其已有状态和通知路由。不得与 Agent 预开启任务同时运行。按[切换步骤](DEPLOYMENT.md)验证真实任务编号和投递证据，不能以 Skill 已安装代替验收。更换接收群时，在原会话停止流程，在新的获准群会话重新创建。
