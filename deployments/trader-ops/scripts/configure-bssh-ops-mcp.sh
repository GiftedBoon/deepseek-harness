#!/usr/bin/env bash
set -euo pipefail

repo_root="/opt/deepseek-harness/current"
deployment_root="$repo_root/deployments/trader-ops"
environment_file="/etc/deepseek-harness/trader-ops.env"
service_file="/etc/systemd/system/dsh-trader-ops.service"
action="${1:---enable}"
default_url="http://192.168.3.213:8095/mcp"

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this bssh_ops MCP configuration as root through sudo.\n' >&2
  exit 1
fi
if [[ "$action" != --enable && "$action" != --disable ]]; then
  printf 'Usage: configure-bssh-ops-mcp.sh [--enable|--disable]\n' >&2
  exit 1
fi
if [[ ! -f "$environment_file" || ! -f "$deployment_root/config/dsh/trader-ops-bssh-ops-mcp.patch.yml" ]]; then
  printf 'Configure the base Trader Ops runtime before enabling bssh_ops MCP.\n' >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$environment_file"
set +a

mcp_url="${TRADER_OPS_BSSH_MCP_URL:-$default_url}"
mcp_key="${TRADER_OPS_BSSH_MCP_API_KEY:-}"
if [[ "$action" == --enable ]]; then
  if [[ -z "$mcp_key" ]]; then
    read -r -s -p 'Enter the bssh_ops MCP X-API-Key: ' mcp_key
    printf '\n'
  fi
  if [[ ! "$mcp_key" =~ ^[A-Za-z0-9._@/:+=-]+$ ]]; then
    printf 'The bssh_ops MCP API key is empty or contains unsupported characters.\n' >&2
    exit 1
  fi
  enabled=1
else
  enabled=0
fi
if [[ ! "$mcp_url" =~ ^http://[^[:space:]#]+/mcp$ && ! "$mcp_url" =~ ^https://[^[:space:]#]+/mcp$ ]]; then
  printf 'TRADER_OPS_BSSH_MCP_URL must be an HTTP(S) URL ending in /mcp.\n' >&2
  exit 1
fi

umask 077
next_environment="$(mktemp)"
cleanup() {
  rm -f -- "$next_environment"
}
trap cleanup EXIT
while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    TRADER_OPS_BSSH_MCP_ENABLED=*|TRADER_OPS_BSSH_MCP_URL=*|TRADER_OPS_BSSH_MCP_API_KEY=*) ;;
    *) printf '%s\n' "$line" >>"$next_environment" ;;
  esac
done <"$environment_file"
cat >>"$next_environment" <<EOF
TRADER_OPS_BSSH_MCP_ENABLED=$enabled
TRADER_OPS_BSSH_MCP_URL=$mcp_url
TRADER_OPS_BSSH_MCP_API_KEY=$mcp_key
EOF
install -o root -g root -m 0600 "$next_environment" "$environment_file"

set -a
# shellcheck source=/dev/null
source "$environment_file"
set +a
cd "$repo_root"
/usr/sbin/runuser --preserve-environment -u dsh -- env \
  CI=true HOME=/var/lib/deepseek-harness PATH=/usr/local/bin:/usr/bin:/bin \
  "$deployment_root/scripts/bootstrap-profile.sh"
/usr/sbin/runuser --preserve-environment -u dsh -- env \
  CI=true HOME=/var/lib/deepseek-harness PATH=/usr/local/bin:/usr/bin:/bin \
  "$deployment_root/scripts/verify-deployment.sh"

install -o root -g root -m 0644 \
  "$deployment_root/config/systemd/dsh-trader-ops.service" "$service_file"
systemctl daemon-reload
systemctl reset-failed dsh-trader-ops
systemctl restart dsh-trader-ops
for _ in {1..60}; do
  if curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3180/ \
    | grep -qE '^(200|401)$' && systemctl is-active --quiet dsh-trader-ops; then
    printf 'Trader Ops bssh_ops MCP is %s.\n' "$(if [[ "$enabled" == 1 ]]; then printf enabled; else printf disabled; fi)"
    exit 0
  fi
  sleep 1
done
printf 'Trader Ops did not become ready after applying the bssh_ops MCP configuration.\n' >&2
systemctl --no-pager --full status dsh-trader-ops >&2 || true
exit 1
