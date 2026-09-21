# Agent Note: Reviewed OpenViking knowledge publishing

Status: implemented

English | [中文](2026-09-18-reviewed-openviking-knowledge-publishing.zh.md)

## Problem

Trader Ops keeps durable business knowledge in Git, while OpenViking recall reads only resources that have been submitted and indexed. Copying files manually through Studio or an Agent tool makes publication state difficult to review, does not reliably distinguish drafts from approved content, and can leave Git and retrieval results inconsistent. Automatic deletion is especially risky because removing an OpenViking resource may also clean memories that reference it.

## Decision

`deployments/trader-ops/scripts/sync-knowledge.mjs` is the operator-controlled publisher from the three knowledge source directories to `viking://resources/trader-ops/knowledge/`. Its default mode performs a local plan only. `--apply` requires a persistent state path and `OPENVIKING_API_KEY`, uploads each changed Markdown file through the OpenViking temporary-upload API, refreshes its exact stable URI, submits source tags plus namespaced domain, type, and owner tags, waits for semantic and vector processing, and checkpoints that file atomically.

The publisher admits non-empty lowercase-path Markdown outside directory READMEs. Drafts remain in Git without publication. Approved entries require a type, domain, owner, date, non-empty tags, and finished body without TODO markers. SHA-256 content hashes distinguish create, update, and unchanged actions. The external state contains no credentials or document text, and an exclusive lock prevents concurrent application against one state file.

Source paths absent from the approved document set are reported as stale but remain in OpenViking. The publisher has no deletion mode. A later deletion capability requires an independently reviewed workflow that previews exact URIs and accounts for memory-reference cleanup.

## Alternatives considered

**Let the Agent call `mcp__openviking__add_resource`.** Rejected because publication is a deployment responsibility and model-authored tool arguments are not a trustworthy source of document approval, target identity, or repository completeness. Production tool policy continues to withhold this write path from the Agent.

**Publish the complete knowledge directory as one resource.** Rejected because drafts and directory documentation would enter retrieval, one invalid document could obscure the affected source, and per-document approval and failure evidence would be lost.

**Use OpenViking Assets for the Harness repository.** Rejected for this source layout because the current Assets protocol treats a Git repository as the asset, while Trader Ops publishes one reviewed subtree with per-file approval. Assets also retains orphaned resources rather than deleting them, so it does not remove the main lifecycle decision this publisher must expose.

**Delete stale resources during ordinary apply.** Rejected because source removal and approval demotion are not sufficient authorization for a remote destructive operation. Retaining and repeatedly reporting stale entries makes that mismatch visible without risking knowledge or related memories.

## Verification

Focused tests cover approved/draft/empty discovery, required metadata rejection, deterministic create/update/unchanged/stale planning, exact authenticated upload and ingestion requests, atomic state persistence, and apply-time state requirements. Deployment verification runs the read-only planner, so invalid approved knowledge blocks a release without contacting OpenViking.

## Consequences

- Git remains the reviewed source of business knowledge, and only approved entries become eligible for retrieval.
- Publication is repeatable and incremental but intentionally operator-triggered rather than scheduled.
- Partial remote success is checkpointed per file; a later run safely retries the remaining changes against stable URIs.
- Stale resources require a separate removal decision and can remain retrievable until that decision is implemented and executed.
