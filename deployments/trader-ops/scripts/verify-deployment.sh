#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(git -C "$deployment_root" rev-parse --show-toplevel)"
profile="${TRADER_OPS_PROFILE:-web}"
endpoint="${OPENVIKING_URL:-http://127.0.0.1:1933}"

: "${DSH_HOME:?Set DSH_HOME to the Harness configuration directory used by this deployment}"

curl --fail --silent --show-error "$endpoint/health" >/dev/null
curl --fail --silent --show-error "$endpoint/ready" >/dev/null

cd "$repo_root"
dump_output="$(pnpm dsh --profile "$profile" \
  --patch "$deployment_root/config/dsh/trader-ops.patch.yml" \
  --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"

skill_count="$(find "$deployment_root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | wc -l | tr -d ' ')"
knowledge_count="$(find "$deployment_root/knowledge" -type f -name '*.md' \
  ! -name README.md ! -name README.zh.md | wc -l | tr -d ' ')"

printf 'OpenViking health and readiness checks passed at %s.\n' "$endpoint"
printf 'DSH profile %s assembled successfully.\n' "$profile"
printf 'Current content: %s loadable skills, %s knowledge documents. Zero is valid for this scaffold.\n' \
  "$skill_count" "$knowledge_count"
