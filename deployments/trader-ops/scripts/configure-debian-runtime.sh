#!/usr/bin/env bash
set -euo pipefail

repo_root="/opt/deepseek-harness/current"
deployment_root="$repo_root/deployments/trader-ops"
environment_file="/etc/deepseek-harness/trader-ops.env"
dsh_cli="$repo_root/apps/cli/lib/bin.js"
lan_proxy_service="dsh-trader-ops-lan-proxy.service"
lan_proxy_socket="dsh-trader-ops-lan-proxy.socket"

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this runtime configuration as root through sudo.\n' >&2
  exit 1
fi
if [[ ! -d "$deployment_root" ]]; then
  printf 'No active Trader Ops release exists at %s.\n' "$deployment_root" >&2
  exit 1
fi
if [[ ! -f "$dsh_cli" ]]; then
  printf 'Built DSH CLI is missing at %s; install a completed release.\n' "$dsh_cli" >&2
  exit 1
fi
if [[ ! -x /lib/systemd/systemd-socket-proxyd ]]; then
  printf 'Debian systemd-socket-proxyd is missing at /lib/systemd/systemd-socket-proxyd.\n' >&2
  exit 1
fi
aihubmix_base_url="${AIHUBMIX_BASE_URL:-https://api.inferera.com/v1}"
aihubmix_model="${AIHUBMIX_MODEL:-deepseek-v4-flash-0731}"
openviking_image="${OPENVIKING_IMAGE:-ghcr.io/volcengine/openviking@sha256:68394a4ed13f60e3c0644adda97c16bb1094c8261e12fc2e9e69d5aefaea3da1}"
requested_lan_host="${TRADER_OPS_LAN_HOST:-}"
trader_ops_lan_host="$requested_lan_host"

validate_lan_host() {
  if [[ -z "$trader_ops_lan_host" ]]; then
    return
  fi
  if ! ip -o -4 address show scope global | awk -v expected="$trader_ops_lan_host" '
    {
      split($4, address, "/")
      if (address[1] == expected) {
        found = 1
      }
    }
    END { exit found ? 0 : 1 }
  '; then
    printf 'TRADER_OPS_LAN_HOST must be an IPv4 address assigned to this host.\n' >&2
    exit 1
  fi
}

validate_lan_host

harness_http_ready() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3180/)" \
    || return 1
  [[ "$status" == 200 || "$status" == 401 ]]
}

lan_http_ready() {
  local status
  [[ -n "$trader_ops_lan_host" ]] || return 0
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --header "Host: $trader_ops_lan_host:3180" "http://$trader_ops_lan_host:3180/")" \
    || return 1
  [[ "$status" == 200 || "$status" == 401 ]]
}

if [[ ! "$aihubmix_base_url" =~ ^https://[^[:space:]#]+$ ]]; then
  printf 'AIHUBMIX_BASE_URL must be an HTTPS URL without whitespace or #.\n' >&2
  exit 1
fi
if [[ ! "$aihubmix_model" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
  printf 'AIHUBMIX_MODEL contains unsupported characters.\n' >&2
  exit 1
fi

tmp_file="$(mktemp)"
socket_file="$(mktemp)"
cleanup() {
  rm -f -- "$tmp_file" "$socket_file"
}
trap cleanup EXIT
umask 077

persist_lan_settings() {
  local authority_found=0
  local host_found=0
  : >"$tmp_file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      TRADER_OPS_LAN_HOST=*)
        printf 'TRADER_OPS_LAN_HOST=%s\n' "$trader_ops_lan_host" >>"$tmp_file"
        host_found=1
        ;;
      TRADER_OPS_WEB_AUTHORITY=*)
        printf 'TRADER_OPS_WEB_AUTHORITY=%s:3180\n' "$trader_ops_lan_host" >>"$tmp_file"
        authority_found=1
        ;;
      TRADER_OPS_WEB_HOST=*)
        ;;
      *)
        printf '%s\n' "$line" >>"$tmp_file"
        ;;
    esac
  done <"$environment_file"
  if [[ "$host_found" == 0 ]]; then
    printf 'TRADER_OPS_LAN_HOST=%s\n' "$trader_ops_lan_host" >>"$tmp_file"
  fi
  if [[ "$authority_found" == 0 ]]; then
    printf 'TRADER_OPS_WEB_AUTHORITY=%s:3180\n' "$trader_ops_lan_host" >>"$tmp_file"
  fi
  install -o root -g root -m 0600 "$tmp_file" "$environment_file"
}

if [[ ! -e "$environment_file" ]]; then
  read -r -s -p 'Enter the rotated AIHubMix API key: ' aihubmix_api_key
  printf '\n'
  if [[ ! "$aihubmix_api_key" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf 'The API key is empty or contains unsupported characters.\n' >&2
    exit 1
  fi
  openviking_root_api_key="$(openssl rand -hex 32)"
  cat >"$tmp_file" <<EOF
TRADER_OPS_PROFILE=web
DSH_HOME=/var/lib/deepseek-harness
DSH_PERMISSION_MODE=read-only
TRADER_OPS_LLM_PROVIDER=aihubmix
TRADER_OPS_LAN_HOST=$trader_ops_lan_host
TRADER_OPS_WEB_AUTHORITY=${trader_ops_lan_host:-127.0.0.1}:3180
AIHUBMIX_BASE_URL=$aihubmix_base_url
AIHUBMIX_API_KEY=$aihubmix_api_key
AIHUBMIX_MODEL=$aihubmix_model
AIHUBMIX_CONTEXT_WINDOW=65536
AIHUBMIX_MAX_TOKENS=4096
OPENVIKING_IMAGE=$openviking_image
OPENVIKING_HOME=/var/lib/openviking
OPENVIKING_SERVER_PORT=1933
OPENVIKING_URL=http://127.0.0.1:1933
OPENVIKING_OLLAMA_BASE_URL=http://host.docker.internal:11434
OPENVIKING_EMBEDDING_MODEL=qwen3-embedding:0.6b
OPENVIKING_QUERY_PLANNER_MODEL=guoxuter/ov_intent_analysis_sft:v7_q8
OPENVIKING_ROOT_API_KEY=$openviking_root_api_key
OPENVIKING_API_KEY=
OPENVIKING_WITH_BOT=0
OPENVIKING_PEER_ID=trader-ops
OPENVIKING_WORKSPACE_PEER=0
OPENVIKING_RECALL_PEER_SCOPE=actor
TRADER_OPS_MCP_ENABLED=0
TRADER_OPS_BSSH_MCP_ENABLED=0
TRADER_OPS_BSSH_MCP_URL=http://192.168.3.213:8095/mcp
TRADER_OPS_BSSH_MCP_API_KEY=
TRADER_OPS_ENVIRONMENT=development
TRADER_OPS_WECOM_ENABLED=0
TRADER_OPS_WECOM_SANDBOX=read-only
WECOM_BOT_ID=
WECOM_BOT_SECRET=
WECOM_SESSION_KEY=
WECOM_ALLOWED_USERS=
WECOM_ALLOWED_CHATS=
WECOM_GROUP_CONVERSATION_MODE=shared
EOF
  install -o root -g root -m 0600 "$tmp_file" "$environment_file"
elif [[ -n "$requested_lan_host" ]]; then
  persist_lan_settings
fi

set -a
# This file is generated by this root-only script and installed as root:root 0600.
# shellcheck source=/dev/null
source "$environment_file"
set +a
trader_ops_lan_host="${TRADER_OPS_LAN_HOST:-}"
validate_lan_host
expected_web_authority="${trader_ops_lan_host:-127.0.0.1}:3180"
if [[ "${TRADER_OPS_WEB_AUTHORITY:-$expected_web_authority}" != "$expected_web_authority" ]]; then
  printf 'TRADER_OPS_WEB_AUTHORITY must match the configured Trader Ops listener.\n' >&2
  exit 1
fi
: "${AIHUBMIX_API_KEY:?The deployment environment has no AIHubMix API key}"
: "${OPENVIKING_ROOT_API_KEY:?The deployment environment has no OpenViking root key}"

install -o root -g root -m 0600 \
  "$deployment_root/config/openviking/ov.conf.linux.example" \
  /var/lib/openviking/ov.conf
install -o root -g root -m 0644 \
  "$deployment_root/config/systemd/dsh-trader-ops.service" \
  /etc/systemd/system/dsh-trader-ops.service
install -o root -g root -m 0644 \
  "$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.service" \
  "/etc/systemd/system/$lan_proxy_service"
if [[ -n "$trader_ops_lan_host" ]]; then
  sed "s/@TRADER_OPS_LAN_HOST@/$trader_ops_lan_host/g" \
    "$deployment_root/config/systemd/dsh-trader-ops-lan-proxy.socket.in" >"$socket_file"
  install -o root -g root -m 0644 "$socket_file" "/etc/systemd/system/$lan_proxy_socket"
else
  systemctl stop "$lan_proxy_service" >/dev/null 2>&1 || true
  systemctl disable --now "$lan_proxy_socket" >/dev/null 2>&1 || true
  rm -f -- "/etc/systemd/system/$lan_proxy_socket"
fi
systemctl daemon-reload

docker compose --env-file "$environment_file" \
  -f "$deployment_root/config/openviking/docker-compose.yml" up -d
for _ in {1..120}; do
  if curl --fail --silent --show-error http://127.0.0.1:1933/health >/dev/null \
    && curl --fail --silent --show-error http://127.0.0.1:1933/ready >/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready:-0}" != 1 ]]; then
  printf 'OpenViking did not become ready within 120 seconds.\n' >&2
  docker compose --env-file "$environment_file" \
    -f "$deployment_root/config/openviking/docker-compose.yml" ps >&2
  exit 1
fi

if [[ -z "${OPENVIKING_API_KEY:-}" ]]; then
  docker exec trader-ops-openviking ov language en >/dev/null
  docker exec trader-ops-openviking ov config add custom \
    --name trader-ops-root --url http://127.0.0.1:1933 \
    --root-api-key-env OPENVIKING_ROOT_API_KEY \
    --account trader-ops --user remote-admin --activate --force >/dev/null
  if ! account_json="$(docker exec trader-ops-openviking ov --sudo -o json \
    admin create-account trader-ops --admin remote-admin)"; then
    account_json="$(docker exec trader-ops-openviking ov --sudo -o json \
      admin regenerate-key trader-ops remote-admin)"
  fi
  user_key="$(printf '%s\n' "$account_json" | python3 -c '
import json
import sys

for line in reversed(sys.stdin.read().splitlines()):
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        continue
    key = payload.get("result", {}).get("user_key")
    if isinstance(key, str) and key:
        print(key)
        raise SystemExit(0)
raise SystemExit("OpenViking did not return result.user_key")
')"
  : >"$tmp_file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == OPENVIKING_API_KEY=* ]]; then
      printf 'OPENVIKING_API_KEY=%s\n' "$user_key" >>"$tmp_file"
    else
      printf '%s\n' "$line" >>"$tmp_file"
    fi
  done <"$environment_file"
  install -o root -g root -m 0600 "$tmp_file" "$environment_file"
  export OPENVIKING_API_KEY="$user_key"
fi

printf '%s' "$OPENVIKING_API_KEY" | docker exec -i trader-ops-openviking \
  ov config add custom --name trader-ops-remote \
  --url http://127.0.0.1:1933 --api-key-stdin \
  --activate --force >/dev/null
docker exec trader-ops-openviking ov doctor

cd "$repo_root"
/usr/sbin/runuser --preserve-environment -u dsh -- env \
  CI=true HOME=/var/lib/deepseek-harness PATH=/usr/local/bin:/usr/bin:/bin \
  "$deployment_root/scripts/bootstrap-profile.sh"
/usr/sbin/runuser --preserve-environment -u dsh -- env \
  CI=true HOME=/var/lib/deepseek-harness PATH=/usr/local/bin:/usr/bin:/bin \
  "$deployment_root/scripts/verify-deployment.sh"
model_output="$(/usr/sbin/runuser --preserve-environment -u dsh -- env \
  CI=true HOME=/var/lib/deepseek-harness PATH=/usr/local/bin:/usr/bin:/bin \
  node "$dsh_cli" --profile headless \
  --patch "$deployment_root/config/dsh/trader-ops.patch.yml" \
  --patch "$deployment_root/config/dsh/trader-ops-aihubmix.patch.yml" \
  --patch "$deployment_root/config/dsh/trader-ops-bssh-ops-mcp.patch.yml" \
  'Reply only REMOTE-MODEL-OK')"
grep -q 'REMOTE-MODEL-OK' <<<"$model_output"
systemctl enable dsh-trader-ops
systemctl reset-failed dsh-trader-ops
systemctl restart dsh-trader-ops
for _ in {1..60}; do
  if harness_http_ready; then
    web_ready=1
    break
  fi
  sleep 1
done
if [[ "${web_ready:-0}" != 1 ]]; then
  systemctl --no-pager --full status dsh-trader-ops >&2 || true
  journalctl --no-pager -u dsh-trader-ops -n 100 >&2
  exit 1
fi
if [[ -n "$trader_ops_lan_host" ]]; then
  systemctl enable "$lan_proxy_socket"
  systemctl reset-failed "$lan_proxy_socket" "$lan_proxy_service"
  systemctl stop "$lan_proxy_service" >/dev/null 2>&1 || true
  systemctl restart "$lan_proxy_socket"
  for _ in {1..30}; do
    if lan_http_ready; then
      lan_ready=1
      break
    fi
    sleep 1
  done
  if [[ "${lan_ready:-0}" != 1 ]]; then
    systemctl --no-pager --full status "$lan_proxy_socket" "$lan_proxy_service" >&2 || true
    journalctl --no-pager -u "$lan_proxy_service" -n 100 >&2
    exit 1
  fi
fi
systemctl is-active --quiet dsh-trader-ops
restart_count="$(systemctl show dsh-trader-ops --property=NRestarts --value)"
sleep 10
if ! harness_http_ready \
  || ! lan_http_ready \
  || ! systemctl is-active --quiet dsh-trader-ops \
  || [[ "$(systemctl show dsh-trader-ops --property=NRestarts --value)" != "$restart_count" ]]; then
  printf 'Trader Ops did not remain stable for the 10-second verification window.\n' >&2
  systemctl --no-pager --full status dsh-trader-ops >&2 || true
  journalctl --no-pager -u dsh-trader-ops -n 100 >&2
  exit 1
fi
printf 'Trader Ops Harness is active at 127.0.0.1:3180; OpenViking is active at 127.0.0.1:1933.\n'
if [[ -n "$trader_ops_lan_host" ]]; then
  printf 'The authenticated private-LAN proxy is active at %s:3180.\n' "$trader_ops_lan_host"
fi
