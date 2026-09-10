#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
environment_file="/etc/deepseek-harness/trader-ops.env"
configure_script="$script_dir/configure-wecom-runtime.sh"
list_only=0
operations=()

usage() {
  cat <<'EOF'
Usage: update-wecom-allowlists.sh --list
       update-wecom-allowlists.sh OPERATION [OPERATION ...]

Operations:
  --add-user USER_ID       admit one enterprise WeCom user
  --remove-user USER_ID    remove one admitted user
  --add-chat CHAT_ID       admit one enterprise WeCom group chat
  --remove-chat CHAT_ID    remove one admitted group chat
  --list                   print both current allowlists without secrets
  -h, --help               show this help

Mutations preserve unspecified entries, reject wildcards, and restart Harness only
when the resulting allowlists changed.
EOF
}

validate_id() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._@/-]+$ ]]; then
    printf '%s must contain only letters, digits, dot, underscore, @, slash, or hyphen.\n' \
      "$label" >&2
    exit 2
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --add-user|--remove-user|--add-chat|--remove-chat)
      if (( $# < 2 )); then
        printf '%s requires one exact id.\n' "$1" >&2
        exit 2
      fi
      validate_id "$1" "$2"
      operations+=("${1#--}:$2")
      shift 2
      ;;
    --list)
      list_only=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$list_only" == 0 && ${#operations[@]} == 0 ]]; then
  usage >&2
  exit 2
fi
if [[ "$list_only" == 1 && ${#operations[@]} != 0 ]]; then
  printf '%s\n' '--list cannot be combined with a mutation.' >&2
  exit 2
fi
if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this allowlist operation as root through sudo.\n' >&2
  exit 1
fi
if [[ ! -f "$environment_file" ]]; then
  printf 'Trader Ops environment is missing at %s; configure the runtime first.\n' \
    "$environment_file" >&2
  exit 1
fi
if [[ ! -f "$configure_script" ]]; then
  printf 'WeCom runtime configurator is missing at %s; install a complete release.\n' \
    "$configure_script" >&2
  exit 1
fi

read_environment_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value = substr($0, length(key) + 2)
      found = 1
    }
    END {
      if (!found) exit 1
      print value
    }
  ' "$environment_file"
}

validate_csv() {
  local label="$1"
  local value="$2"
  local required="$3"
  if [[ -z "$value" ]]; then
    if [[ "$required" == 1 ]]; then
      printf '%s must contain at least one exact id.\n' "$label" >&2
      exit 1
    fi
    return
  fi
  if [[ ! "$value" =~ ^[A-Za-z0-9._@/-]+(,[A-Za-z0-9._@/-]+)*$ ]]; then
    printf '%s in %s is not a valid exact-id list.\n' "$label" "$environment_file" >&2
    exit 1
  fi
}

csv_contains() {
  local csv="$1"
  local value="$2"
  [[ ",$csv," == *",$value,"* ]]
}

csv_add() {
  local csv="$1"
  local value="$2"
  if [[ -z "$csv" ]]; then
    printf '%s' "$value"
  else
    printf '%s,%s' "$csv" "$value"
  fi
}

csv_remove() {
  local csv="$1"
  local target="$2"
  local item
  local result=""
  local items=()
  IFS=',' read -r -a items <<<"$csv"
  for item in "${items[@]}"; do
    if [[ "$item" == "$target" ]]; then
      continue
    fi
    result="${result:+$result,}$item"
  done
  printf '%s' "$result"
}

enabled="$(read_environment_value TRADER_OPS_WECOM_ENABLED)" || {
  printf 'TRADER_OPS_WECOM_ENABLED is missing from %s.\n' "$environment_file" >&2
  exit 1
}
users="$(read_environment_value WECOM_ALLOWED_USERS)" || {
  printf 'WECOM_ALLOWED_USERS is missing from %s.\n' "$environment_file" >&2
  exit 1
}
chats="$(read_environment_value WECOM_ALLOWED_CHATS)" || {
  printf 'WECOM_ALLOWED_CHATS is missing from %s.\n' "$environment_file" >&2
  exit 1
}
validate_csv WECOM_ALLOWED_USERS "$users" 1
validate_csv WECOM_ALLOWED_CHATS "$chats" 0

if [[ "$list_only" == 1 ]]; then
  printf 'WECOM_ALLOWED_USERS=%s\n' "$users"
  printf 'WECOM_ALLOWED_CHATS=%s\n' "$chats"
  exit 0
fi
if [[ "$enabled" != 1 ]]; then
  printf 'Enterprise WeCom is disabled; enable it before changing runtime allowlists.\n' >&2
  exit 1
fi

original_users="$users"
original_chats="$chats"
for operation in "${operations[@]}"; do
  action="${operation%%:*}"
  value="${operation#*:}"
  case "$action" in
    add-user)
      if ! csv_contains "$users" "$value"; then
        users="$(csv_add "$users" "$value")"
      fi
      ;;
    remove-user)
      if ! csv_contains "$users" "$value"; then
        printf 'User id is not present in WECOM_ALLOWED_USERS: %s\n' "$value" >&2
        exit 1
      fi
      users="$(csv_remove "$users" "$value")"
      ;;
    add-chat)
      if ! csv_contains "$chats" "$value"; then
        chats="$(csv_add "$chats" "$value")"
      fi
      ;;
    remove-chat)
      if ! csv_contains "$chats" "$value"; then
        printf 'Chat id is not present in WECOM_ALLOWED_CHATS: %s\n' "$value" >&2
        exit 1
      fi
      chats="$(csv_remove "$chats" "$value")"
      ;;
  esac
done
validate_csv WECOM_ALLOWED_USERS "$users" 1
validate_csv WECOM_ALLOWED_CHATS "$chats" 0

if [[ "$users" == "$original_users" && "$chats" == "$original_chats" ]]; then
  printf 'The enterprise WeCom allowlists are unchanged; Harness was not restarted.\n'
else
  WECOM_ALLOWED_USERS="$users" WECOM_ALLOWED_CHATS="$chats" \
    bash "$configure_script" --enable
fi
printf 'WECOM_ALLOWED_USERS=%s\n' "$users"
printf 'WECOM_ALLOWED_CHATS=%s\n' "$chats"
