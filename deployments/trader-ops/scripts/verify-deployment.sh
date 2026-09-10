#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(CDPATH= cd -- "$deployment_root/../.." && pwd)"
profile="${TRADER_OPS_PROFILE:-web}"
dsh_cli="$repo_root/apps/cli/lib/bin.js"
policy_plugin="$repo_root/packages/experimental/quant-tool-policy/lib/index.js"
logger_plugin="$repo_root/vendor/logger-console/lib/index.js"
wecom_plugin="$repo_root/packages/channel/channel-wecom/lib/index.js"
wecom_patch="$deployment_root/config/dsh/trader-ops-wecom.patch.yml"
lan_proxy_service="$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.service"
lan_proxy_socket="$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.socket.in"
endpoint="${OPENVIKING_URL:-http://127.0.0.1:1933}"

: "${DSH_HOME:?Set DSH_HOME to the Harness configuration directory used by this deployment}"
wecom_preset="$DSH_HOME/profiles/$profile/agent-presets/trader-ops-wecom/agent.cordis.yml"
if [[ ! -f "$dsh_cli" ]]; then
  printf 'Built DSH CLI is missing at %s; install a completed release.\n' "$dsh_cli" >&2
  exit 1
fi
if [[ ! -f "$policy_plugin" || ! -f "$logger_plugin" ]]; then
  printf 'Built Trader Ops policy or console logger plugin is missing; install a completed release.\n' >&2
  exit 1
fi
if [[ ! -f "$wecom_plugin" || ! -f "$wecom_patch" || ! -f "$wecom_preset" ]]; then
  printf 'Trader Ops WeCom plugin, patch, or generated preset is missing.\n' >&2
  exit 1
fi
if [[ ! -f "$lan_proxy_service" || ! -f "$lan_proxy_socket" ]]; then
  printf 'Trader Ops private-LAN proxy units are missing from %s.\n' \
    "$deployment_root/config/systemd" >&2
  exit 1
fi

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
patch_args+=(--patch "$wecom_patch")
dump_output="$(node "$dsh_cli" --profile "$profile" "${patch_args[@]}" --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-console-logger' <<<"$dump_output"
grep -q 'channel-wecom: 2' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"
grep -q 'trader-ops-wecom' <<<"$dump_output"
grep -q 'includeHarnessIdentity: false' <<<"$dump_output"
grep -Fq '我是CFI 股票交易组的 AI Agent 智能助手' "$wecom_preset"
awk '
  $0 == "- id: tool-ask-user" {
    getline
    getline
    if ($0 == "  disabled: true") found = 1
  }
  END { exit found ? 0 : 1 }
' "$wecom_preset"
if [[ "${TRADER_OPS_WECOM_ENABLED:-0}" == 1 ]]; then
  : "${WECOM_BOT_ID:?Set the enterprise WeCom bot id}"
  : "${WECOM_BOT_SECRET:?Set the enterprise WeCom bot secret}"
  : "${WECOM_SESSION_KEY:?Set the stable WeCom Session identity key}"
  : "${WECOM_ALLOWED_USERS:?Set exact comma-separated enterprise WeCom user ids}"
  if [[ ! "$WECOM_ALLOWED_USERS" =~ ^[A-Za-z0-9._@/-]+(,[A-Za-z0-9._@/-]+)*$ ]] \
    || [[ -n "${WECOM_ALLOWED_CHATS:-}" \
      && ! "$WECOM_ALLOWED_CHATS" =~ ^[A-Za-z0-9._@/-]+(,[A-Za-z0-9._@/-]+)*$ ]]; then
    printf 'Trader Ops WeCom allowlists must contain exact comma-separated ids.\n' >&2
    exit 1
  fi
  case "${WECOM_GROUP_CONVERSATION_MODE:-shared}" in
    shared|per-user) ;;
    *)
      printf 'WECOM_GROUP_CONVERSATION_MODE must be shared or per-user.\n' >&2
      exit 1
      ;;
  esac
  case "${TRADER_OPS_WECOM_SANDBOX:-read-only}" in
    read-only|workspace-write) ;;
    *)
      printf 'TRADER_OPS_WECOM_SANDBOX must be read-only or workspace-write.\n' >&2
      exit 1
      ;;
  esac
  grep -q 'trader-ops-wecom-channel' <<<"$dump_output"
fi
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
printf 'Trader Ops WeCom channel: %s.\n' \
  "$(if [[ "${TRADER_OPS_WECOM_ENABLED:-0}" == 1 ]]; then printf enabled; else printf disabled; fi)"
printf 'Current content: %s loadable skills, %s non-empty knowledge documents. Zero is valid for this scaffold.\n' \
  "$skill_count" "$knowledge_count"
if (( empty_knowledge_count > 0 )); then
  printf 'Ignored %s empty knowledge placeholders; ingestion must skip empty or whitespace-only files.\n' \
    "$empty_knowledge_count"
fi
