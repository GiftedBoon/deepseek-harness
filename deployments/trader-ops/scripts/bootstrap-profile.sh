#!/usr/bin/env bash
set -euo pipefail

# Plugin installation runs pnpm only inside the writable DSH Profile directory.
export CI="${CI:-true}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
deployment_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
repo_root="$(CDPATH= cd -- "$deployment_root/../.." && pwd)"
dsh_cli="$repo_root/apps/cli/lib/bin.js"
profile="${TRADER_OPS_PROFILE:-web}"
plugin_version="${OPENVIKING_DSH_PLUGIN_VERSION:-0.3.0}"

: "${DSH_HOME:?Set DSH_HOME to a writable, persistent Harness configuration directory}"
if [[ ! -f "$dsh_cli" ]]; then
  printf 'Built DSH CLI is missing at %s; install a completed release.\n' "$dsh_cli" >&2
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

dump_output="$(node "$dsh_cli" --profile "$profile" \
  --patch "$deployment_root/config/dsh/trader-ops.patch.yml" \
  --dump-config)"

grep -q 'openviking-memory-runtime' <<<"$dump_output"
grep -q 'trader-ops-tool-policy' <<<"$dump_output"
grep -q 'trader-ops-skills' <<<"$dump_output"

printf 'Profile %s is ready in %s.\n' "$profile" "$DSH_HOME"
printf 'OpenViking plugin: @openviking/dsh-memory-plugin@%s\n' "$plugin_version"
printf 'Effective configuration contains OpenViking, the Trader Ops tool policy, and the skill provider.\n'
