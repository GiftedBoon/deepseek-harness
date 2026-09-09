#!/usr/bin/env bash
set -euo pipefail

# Profile commands may reconcile pnpm state. Deployment scripts do not have a
# terminal available to answer pnpm's module-directory confirmation prompt.
export CI="${CI:-true}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(CDPATH= cd -- "$deployment_root/../.." && pwd)"
profile="${TRADER_OPS_PROFILE:-web}"
endpoint="${OPENVIKING_URL:-http://127.0.0.1:1933}"

: "${DSH_HOME:?Set DSH_HOME to the Harness configuration directory used by this deployment}"

curl --fail --silent --show-error "$endpoint/health" >/dev/null
curl --fail --silent --show-error "$endpoint/ready" >/dev/null

cd "$repo_root"
patch_args=(--patch "$deployment_root/config/dsh/trader-ops.patch.yml")
llm_provider="${TRADER_OPS_LLM_PROVIDER:-default}"
case "$llm_provider" in
  default)
    ;;
  aihubmix)
    : "${AIHUBMIX_BASE_URL:?Set the AIHubMix OpenAI-compatible endpoint}"
    : "${AIHUBMIX_API_KEY:?Set the AIHubMix API key}"
    : "${AIHUBMIX_MODEL:?Set the AIHubMix model id}"
    patch_args+=(--patch "$deployment_root/config/dsh/trader-ops-aihubmix.patch.yml")
    ;;
  *)
    printf 'Unsupported TRADER_OPS_LLM_PROVIDER: %s\n' "$llm_provider" >&2
    exit 1
    ;;
esac
dump_output="$(pnpm dsh --profile "$profile" "${patch_args[@]}" --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"
case "$llm_provider" in
  aihubmix)
    grep -q 'provider: trader-ops-aihubmix' <<<"$dump_output"
    grep -q 'apiKeyEnv: AIHUBMIX_API_KEY' <<<"$dump_output"
    grep -q 'AIHUBMIX_MODEL' <<<"$dump_output"
    ;;
esac

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
