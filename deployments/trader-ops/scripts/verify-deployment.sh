#!/usr/bin/env bash
set -euo pipefail

# Profile commands may reconcile pnpm state. Deployment scripts do not have a
# terminal available to answer pnpm's module-directory confirmation prompt.
export CI="${CI:-true}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(git -C "$deployment_root" rev-parse --show-toplevel)"
profile="${TRADER_OPS_PROFILE:-web}"
endpoint="${OPENVIKING_URL:-http://127.0.0.1:1933}"

: "${DSH_HOME:?Set DSH_HOME to the Harness configuration directory used by this deployment}"

curl --fail --silent --show-error "$endpoint/health" >/dev/null
curl --fail --silent --show-error "$endpoint/ready" >/dev/null

cd "$repo_root"
patch_args=(--patch "$deployment_root/config/dsh/trader-ops.patch.yml")
if [[ "${TRADER_OPS_LOCAL_LLM_ENABLED:-false}" == true ]]; then
  : "${TRADER_OPS_LOCAL_LLM_API_KEY:?Set the non-secret Ollama adapter placeholder key}"
  : "${TRADER_OPS_LOCAL_LLM_BASE_URL:?Set the local Ollama OpenAI-compatible endpoint}"
  : "${TRADER_OPS_LOCAL_LLM_MODEL:?Set the local Ollama model id}"
  patch_args+=(--patch "$deployment_root/config/dsh/trader-ops-local-ollama.patch.yml")
fi
dump_output="$(pnpm dsh --profile "$profile" "${patch_args[@]}" --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"
if [[ "${TRADER_OPS_LOCAL_LLM_ENABLED:-false}" == true ]]; then
  grep -q 'provider: trader-ops-local' <<<"$dump_output"
  grep -q 'apiKeyEnv: TRADER_OPS_LOCAL_LLM_API_KEY' <<<"$dump_output"
  grep -q 'TRADER_OPS_LOCAL_LLM_MODEL' <<<"$dump_output"
fi

skill_count="$(find "$deployment_root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | wc -l | tr -d ' ')"
knowledge_count=0
empty_knowledge_count=0
while IFS= read -r -d '' knowledge_file; do
  if grep -q '[^[:space:]]' "$knowledge_file"; then
    knowledge_count=$((knowledge_count + 1))
  else
    empty_knowledge_count=$((empty_knowledge_count + 1))
  fi
done < <(find "$deployment_root/knowledge" -type f -name '*.md' \
  ! -name README.md ! -name README.zh.md -print0)

printf 'OpenViking health and readiness checks passed at %s.\n' "$endpoint"
printf 'DSH profile %s assembled successfully.\n' "$profile"
printf 'Current content: %s loadable skills, %s non-empty knowledge documents. Zero is valid for this scaffold.\n' \
  "$skill_count" "$knowledge_count"
if (( empty_knowledge_count > 0 )); then
  printf 'Ignored %s empty knowledge placeholders; ingestion must skip empty or whitespace-only files.\n' \
    "$empty_knowledge_count"
fi
