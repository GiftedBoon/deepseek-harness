#!/usr/bin/env bash
set -euo pipefail

service="dsh-trader-ops"
endpoint="http://127.0.0.1:3180/"

if (( $# != 0 )); then
  printf 'Usage: restart-runtime.sh\n' >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this service restart as root through sudo.\n' >&2
  exit 1
fi
if ! systemctl cat "$service" >/dev/null 2>&1; then
  printf 'The %s systemd unit is not installed; configure the runtime first.\n' "$service" >&2
  exit 1
fi

harness_ready() {
  local status
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 2 "$endpoint" 2>/dev/null)" || return 1
  [[ "$status" == 200 || "$status" == 401 ]]
}

systemctl reset-failed "$service"
systemctl restart "$service"
for _ in {1..60}; do
  if systemctl is-active --quiet "$service" && harness_ready; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "${ready:-0}" != 1 ]]; then
  printf '%s did not become ready at %s within 60 seconds.\n' "$service" "$endpoint" >&2
  printf 'Inspect root-only service diagnostics; do not share the authenticated startup URL.\n' >&2
  exit 1
fi

restart_count="$(systemctl show "$service" --property=NRestarts --value)"
sleep 5
if ! systemctl is-active --quiet "$service" \
  || ! harness_ready \
  || [[ "$(systemctl show "$service" --property=NRestarts --value)" != "$restart_count" ]]; then
  printf '%s did not remain stable for the five-second verification period.\n' "$service" >&2
  printf 'Inspect root-only service diagnostics; do not share the authenticated startup URL.\n' >&2
  exit 1
fi

main_pid="$(systemctl show "$service" --property=MainPID --value)"
printf 'Trader Ops Harness is ready at %s (pid %s, automatic restarts %s).\n' \
  "$endpoint" "$main_pid" "$restart_count"
