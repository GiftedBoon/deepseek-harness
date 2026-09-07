# Skills：可执行任务说明

本目录保存 Harness 可发现的 Skill bundle。每个一级子目录包含一个 `SKILL.md`；Harness 先把 `name` 和 `description` 发布到 Skill catalog，任务匹配后由 Skill Loader 读取完整正文。Skill 不应进入 OpenViking 的普通知识索引。

## 应该放在这里

- Agent 完成一类任务时必须遵守的完整步骤、校验和停止条件。
- 允许调用的 MCP tools、输入要求、输出格式和失败处理。
- Skill 专用的 `references/`、`scripts/` 或 `assets/` 配套资源。
- 合法的 YAML frontmatter：`name`、`description`，以及需要时的 `whenToUse`、`disable-model-invocation`、`user-invocable`。

## 不应该放在这里

- 大段通用业务百科或系统说明；放在 `../knowledge/` 并按需检索。
- MCP tool 的实现和凭据。
- 仅用于权限、审批或风险分级的规则；放在 `../policies/` 并由执行路径强制实施。
- 依赖模型从摘要猜测的关键步骤；所有必要步骤必须写入完整 `SKILL.md`。

## Skill bundle 示例

```text
skills/
└── example-task/
    ├── SKILL.md
    └── references/
        └── output-format.md
```

```markdown
---
name: example-task
description: 查询指定对象并返回带来源的结果，不执行写操作。
whenToUse: 用户要求查询指定对象的当前状态时。
user-invocable: true
---

# Example Task

1. 解析并复述对象标识。
2. 调用只读 MCP tool 获取实时数据。
3. 对照检索到的业务定义解释字段。
4. 返回查询时间、数据来源和结果；不得把缓存知识当作当前状态。
```

文件系统 Provider 只发现 Skill root 的直接子项：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`。因此不要再增加业务分类层级。
