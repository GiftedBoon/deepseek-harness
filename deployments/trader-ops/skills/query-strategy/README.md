# query-strategy skill

English | [中文](README.zh.md)

This directory contains the complete "query product strategy" skill bundle. The skill uses retrieved knowledge to interpret fields, calls MCP tools for current bindings or historical switches, and clearly distinguishes the two result types.

## What belongs here

- Intent recognition and parameter rules for current and historical strategy queries.
- Product disambiguation, default time ranges, ordering, and result-summary requirements.
- A read-only tool allowlist and data-freshness guidance.

## What does not belong here

- Long explanations of strategy concepts or switching rules; place them in `../../knowledge/business/`.
- Strategy switching, start/stop, or configuration-change steps.
- Static copies of historical query results.
- SQL, database passwords, or access paths that bypass MCP.

## `SKILL.md` example

```markdown
---
name: query-strategy
description: Read a product's current strategy or strategy-switch history for a specified time range.
whenToUse: Use when the user asks which strategy a product uses or requests its strategy history.
user-invocable: true
---

# Query Strategy

1. Extract the product code and decide whether the user needs the current binding or historical records.
2. Call `get_product_strategy` for the current binding or `query_strategy_history` for historical records.
3. When the user omits a historical range, use the deployment default and state that range in the output.
4. Sort history newest first and show `old_strategy → new_strategy`, operator, and timestamp.
5. Return the live data source and query time; never call a write tool.
```
