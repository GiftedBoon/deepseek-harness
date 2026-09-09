#!/usr/bin/env bash
set -euo pipefail

# Plugin installation runs pnpm only inside the writable DSH Profile directory.
export CI="${CI:-true}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(CDPATH= cd -- "$deployment_root/../.." && pwd)"
profile="${TRADER_OPS_PROFILE:-web}"
dsh_cli="$repo_root/apps/cli/lib/bin.js"
policy_plugin="$repo_root/packages/experimental/quant-tool-policy/lib/index.js"
wecom_plugin="$repo_root/packages/channel/channel-wecom/lib/index.js"
wecom_patch="$deployment_root/config/dsh/trader-ops-wecom.patch.yml"
wecom_preset_source="$repo_root/packages/preset/agent-presets/presets/standard"
lan_proxy_service="$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.service"
lan_proxy_socket="$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.socket.in"
plugin_version="${OPENVIKING_DSH_PLUGIN_VERSION:-0.3.0}"

: "${DSH_HOME:?Set DSH_HOME to a writable, persistent Harness configuration directory}"
wecom_preset_root="$DSH_HOME/profiles/$profile/agent-presets"
wecom_preset="$wecom_preset_root/trader-ops-wecom"
if [[ ! -f "$dsh_cli" ]]; then
  printf 'Built DSH CLI is missing at %s; install a completed release.\n' "$dsh_cli" >&2
  exit 1
fi
if [[ ! -f "$policy_plugin" ]]; then
  printf 'Built Trader Ops policy plugin is missing at %s; install a completed release.\n' "$policy_plugin" >&2
  exit 1
fi
if [[ ! -f "$wecom_plugin" || ! -f "$wecom_patch" ]]; then
  printf 'Built WeCom channel or its Trader Ops patch is missing from %s.\n' "$deployment_root" >&2
  exit 1
fi
if [[ ! -f "$lan_proxy_service" || ! -f "$lan_proxy_socket" ]]; then
  printf 'Trader Ops private-LAN proxy units are missing from %s.\n' \
    "$deployment_root/config/systemd" >&2
  exit 1
fi

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major < 22 || major === 23 || (major === 22 && minor < 19)) {
    console.error(`Node ${process.versions.node} is unsupported; use Node 22.19+ or 24+`)
    process.exit(1)
  }
'

cd "$repo_root"
node "$dsh_cli" plugin --profile "$profile" add "@openviking/dsh-memory-plugin@$plugin_version"
node "$dsh_cli" plugin --profile "$profile" add "$repo_root/packages/channel/channel-wecom"
node "$deployment_root/scripts/render-wecom-preset.mjs" "$wecom_preset_source" "$wecom_preset"

dump_output="$(node "$dsh_cli" --profile "$profile" \
  --patch "$deployment_root/config/dsh/trader-ops.patch.yml" \
  --patch "$wecom_patch" \
  --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"
grep -q 'trader-ops-wecom' <<<"$dump_output"

printf 'Profile %s is ready in %s.\n' "$profile" "$DSH_HOME"
printf 'OpenViking plugin: @openviking/dsh-memory-plugin@%s\n' "$plugin_version"
printf 'Effective configuration contains OpenViking, the Trader Ops tool policy, the skill provider, and the optional WeCom channel.\n'
