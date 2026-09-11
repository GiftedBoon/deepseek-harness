#!/usr/bin/env bash
set -euo pipefail

service="dsh-trader-ops"
since="24 hours ago"
limit=20
follow=0
kind="user"

usage() {
  cat <<'EOF'
Usage: list-rejected-wecom-users.sh [--kind user|group] [--since TIME] [--limit COUNT] [--follow]

Print only the timestamp and rejected enterprise WeCom user_id or group chatid.

Options:
  --kind KIND    rejected identity to print; user (default) or group
  --since TIME   journalctl time expression; default: 24 hours ago
  --limit COUNT  maximum historical rows; default: 20
  --follow       continue watching for new rejected users
  -h, --help     show this help
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --kind)
      if (( $# < 2 )) || [[ "$2" != user && "$2" != group ]]; then
        printf '%s\n' '--kind must be user or group.' >&2
        exit 2
      fi
      kind="$2"
      shift 2
      ;;
    --since)
      if (( $# < 2 )); then
        printf '%s\n' '--since requires a journalctl time expression.' >&2
        exit 2
      fi
      since="$2"
      shift 2
      ;;
    --limit)
      if (( $# < 2 )) || [[ ! "$2" =~ ^[1-9][0-9]*$ ]] || (( 10#$2 > 1000 )); then
        printf '%s\n' '--limit requires an integer from 1 through 1000.' >&2
        exit 2
      fi
      limit=$((10#$2))
      shift 2
      ;;
    --follow)
      follow=1
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

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this identity-log query as root through sudo.\n' >&2
  exit 1
fi

extract_rejections() {
  awk -v kind="$kind" '
    {
      if (kind == "user") {
        marker = "WeCom sender is not allowed: userid=\""
      } else {
        marker = "WeCom group chat is not allowed: chatid=\""
      }
      start = index($0, marker)
      if (start == 0) next
      value = substr($0, start + length(marker))
      finish = index(value, "\"")
      if (finish <= 1) next
      printf "%s\t%s\n", $1, substr(value, 1, finish - 1)
      fflush()
    }
  '
}

if [[ "$follow" == 1 ]]; then
  if [[ "$kind" == user ]]; then printf 'TIMESTAMP\tUSER_ID\n'; else printf 'TIMESTAMP\tCHAT_ID\n'; fi
  journalctl --unit "$service" --since "$since" --follow --output short-iso \
    | extract_rejections
  exit 0
fi

records="$(journalctl --unit "$service" --since "$since" --no-pager --output short-iso \
  | extract_rejections)"
if [[ -z "$records" ]]; then
  if [[ "$kind" == user ]]; then
    printf 'No rejected enterprise WeCom users found since %s.\n' "$since"
  else
    printf 'No rejected enterprise WeCom group chats found since %s.\n' "$since"
  fi
  exit 0
fi

mapfile -t rows <<<"$records"
start=0
if (( ${#rows[@]} > limit )); then
  start=$((${#rows[@]} - limit))
fi
if [[ "$kind" == user ]]; then printf 'TIMESTAMP\tUSER_ID\n'; else printf 'TIMESTAMP\tCHAT_ID\n'; fi
for (( index = start; index < ${#rows[@]}; index += 1 )); do
  printf '%s\n' "${rows[index]}"
done
