# Skills：可执行任务说明

[English](README.md) | 中文

本目录保存 Harness 可发现的 Skill bundle。每个一级子目录包含一个 `SKILL.md`；Harness 先把 `name` 和 `description` 发布到 Skill catalog，任务匹配后由 Skill Loader 读取完整正文。Skill 不应进入 OpenViking 的普通知识索引。

## 应该放在这里

- Agent 完成一类任务时必须遵守的完整步骤、校验和停止条件。
- 允许调用的 MCP tools、输入要求、输出格式和失败处理。
- 工具清单中以完整 `mcp__<server>__<tool>` 名称书写的 MCP tool 引用，供 `../scripts/verify-skill-tool-policy.mjs` 解析到 `../policies/tool-access.yaml`。
- Skill 专用的 `references/`、`scripts/` 或 `assets/` 配套资源。
- 合法的 YAML frontmatter：`name`、`description`，以及需要时的 `whenToUse`、`disable-model-invocation`、`user-invocable`。

## 不应该放在这里

- 大段通用业务百科或系统说明；放在 `../knowledge/` 并按需检索。
- MCP tool 的实现和凭据。
- 仅用于权限、审批或风险分级的规则；放在 `../policies/` 并由执行路径强制实施。
- 依赖模型从摘要猜测的关键步骤；所有必要步骤必须写入完整 `SKILL.md`。

## Skill 还是 Knowledge

按内容必须以什么方式到达 Agent 来判断。Skill 在任务匹配时完整加载并逐步执行；Knowledge 只在相关时以片段形式被检索，用作参考。

| 问题 | 归属 |
|---|---|
| 是否定义了 Agent 必须遵守的步骤、工具调用、停止条件或固定输出格式？ | Skill |
| 只检索到片段时，Agent 是否会漏步骤或答错？ | Skill |
| 是术语、字段含义、分类、规则或系统说明吗？ | Knowledge |
| 多个 Skill 依赖同一事实吗？ | Knowledge；各 Skill 只写自己需要的部分并链接该事实 |
| 是给人看的诊断顺序或恢复指引吗？ | `../knowledge/runbooks/` 下的 Knowledge；仅当 Agent 必须执行时再增加 Skill |
| 是否授予、拒绝或审批工具调用？ | `../policies/`，不写入 Skill 或 Knowledge |

每个事实只有一个归属。工具返回的值或由工具定义的表保留在工具中，Skill 和 Knowledge 都不复制。

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
description: Query a specified object and return a sourced result without writing.
whenToUse: Use when the user requests the current state of a specified object.
user-invocable: true
---

# Example Task

1. Parse and restate the object identifier.
2. Call a read-only MCP tool for live data.
3. Interpret the fields against retrieved business definitions.
4. Return the query time, data source, and result; never present cached knowledge as current state.
```

文件系统 Provider 只发现 Skill root 的直接子项：`<root>/<name>/SKILL.md` 或 `<root>/<name>.md`。因此不要再增加业务分类层级。
