# query-product skill

English | [中文](README.zh.md)

This directory contains the complete "query product" skill bundle. Add `SKILL.md` when implementing it; Harness Skill Loader then loads the complete file on demand and uses live tool results to answer product-status questions.

## What belongs here

- Product identifier parsing, disambiguation, querying, result validation, and presentation steps.
- Permitted read-only tools and handling for missing or multiple results.
- Required result fields such as query time, source, and product data.

## What does not belong here

- The authoritative definition of product terms or field conventions; place it in `../../knowledge/business/`.
- Product data snapshots or a hard-coded current state.
- Operations that modify a product, strategy, or production configuration.
- Database connection implementation for the query tool.

## `SKILL.md` example

```markdown
---
name: query-product
description: Query product metadata and current state without changing business data.
whenToUse: Use when the user asks whether a product exists or asks for its metadata or current state.
user-invocable: true
---

# Query Product

1. Extract the product code from the request; ask when it is missing and never guess.
2. Call `get_product`; never substitute a historical knowledge-base value for a live query.
3. For no result, state the source and query conditions; for multiple results, disambiguate first.
4. Return product code, name, state, environment, query time, and data source.
5. This skill is read-only and must not call a create, update, delete, or switch tool.
```
