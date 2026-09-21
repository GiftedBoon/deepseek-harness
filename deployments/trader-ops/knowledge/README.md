# Knowledge: retrievable business information

English | [中文](README.zh.md)

This directory is the Git source for team business knowledge. Reviewed documents are synchronized to OpenViking, where the agent retrieves fragments relevant to the current question; unlike a skill, they are not loaded completely or unconditionally.

Knowledge entries under `business/`, `systems/`, and `runbooks/` are deployment content and may be written in Chinese only. Do not create an English counterpart or `.i18n.yaml` record for an ordinary knowledge entry. Directory `README` files remain bilingual repository documentation and stay outside OpenViking ingestion.

## What belongs here

- Stable business concepts, terminology, field meanings, and business rules.
- System responsibilities, dependencies, interface descriptions, and data-source guidance.
- Runbook context, decision criteria, diagnostic steps, and recovery verification.
- Markdown with consistent YAML frontmatter that supports chunking and retrieval.

## What does not belong here

- Task procedures that the agent must follow step by step; write these as `../skills/<name>/SKILL.md`.
- Permission, approval, or tool-blocking rules; place these in `../policies/`.
- Current strategies, today's status, or live logs; query them through MCP or an API.
- Unreviewed temporary experience or raw data that contains secrets.

## Templates

Obsidian reads the Chinese-only deployment templates from `../templates/knowledge`, outside the OpenViking ingestion root. Choose the template for the target knowledge directory, replace every `TODO`, keep the document in `draft` status during review, and change the status only when the owner approves it.

- Business: [rule](../templates/knowledge/business-rule.md) and [glossary](../templates/knowledge/business-glossary.md).
- Systems: [system overview](../templates/knowledge/system-overview.md) and [data source](../templates/knowledge/data-source.md).
- Runbooks: [incident response](../templates/knowledge/incident-runbook.md) and [controlled change](../templates/knowledge/change-runbook.md).

## Publishing

The publisher reads only non-empty Markdown below `business/`, `systems/`, and `runbooks/`. It excludes directory READMEs, ignores `draft` entries, and rejects an `approved` entry unless `type`, `domain`, `owner`, `updated_at`, non-empty `tags`, and finished body content are present. Knowledge filenames use lowercase ASCII slugs so their Git paths map to stable OpenViking URIs. The original tags plus `domain:`, `type:`, and `owner:` namespaced tags are submitted to OpenViking for retrieval filtering.

Planning is the default and performs no network writes:

```bash
node deployments/trader-ops/scripts/sync-knowledge.mjs \
  --state "$DSH_HOME/knowledge-sync/trader-ops.json"
```

After reviewing the plan, publish changed files with the tenant API key in the environment:

```bash
node deployments/trader-ops/scripts/sync-knowledge.mjs \
  --apply \
  --state "$DSH_HOME/knowledge-sync/trader-ops.json"
```

Each successful file is checkpointed atomically after OpenViking finishes semantic processing and vectorization. A failed file leaves its prior state entry unchanged. The state file contains source paths, content hashes, resource URIs, task ids, and publication times but no credentials or document bodies. Only one publisher may own a state file at a time.

Removed or demoted source files appear as `stale` in every plan. This initial publisher never deletes OpenViking resources; removal remains a separate reviewed operation because it can also clean memories that reference the resource.

## Recommended document format

```markdown
---
type: business-rule
domain: trading
owner: trading-platform
status: approved
updated_at: 2026-09-07
tags:
  - product
  - strategy
---

# Product and strategy relationship

One product can bind to only one active strategy at a time.

## Data source

Query the current binding through the `get_product_strategy` MCP tool.

## Related material

- [Strategy switch rules](business/strategy-switch-rule.md)
- [Strategy switch runbook](runbooks/switch-strategy.md)
```

Frontmatter supports OpenViking filtering, authorization, and result ordering. The body contains stable facts; for changing values, name the authoritative source and query method instead of copying the current value.
