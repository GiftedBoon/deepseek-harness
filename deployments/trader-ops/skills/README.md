# Skills: executable task instructions

English | [中文](README.zh.md)

This directory contains skill bundles discovered by Harness. Each direct child directory contains one `SKILL.md`. Harness first publishes its `name` and `description` in the skill catalog, then Skill Loader reads the complete body when a task matches. OpenViking must not index skills as ordinary knowledge.

## What belongs here

- Complete steps, validations, and stopping conditions that the agent must follow for one task class.
- Permitted MCP tools, input requirements, output format, and failure handling.
- Skill-specific `references/`, `scripts/`, or `assets/` resources.
- Valid YAML frontmatter: `name`, `description`, and, when required, `whenToUse`, `disable-model-invocation`, or `user-invocable`.

## What does not belong here

- General business encyclopaedia or system descriptions; place them in `../knowledge/` for retrieval.
- MCP tool implementations or credentials.
- Permission, approval, or risk classification rules; place them in `../policies/` and enforce them on the execution path.
- Critical steps that require the model to guess from a summary; put every required step in the complete `SKILL.md`.

## Skill bundle example

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

The filesystem provider discovers only direct children of the skill root: `<root>/<name>/SKILL.md` or `<root>/<name>.md`. Do not add another business-category level.
