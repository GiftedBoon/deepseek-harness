#!/usr/bin/env bash
set -euo pipefail

service="dsh-trader-ops"
since="24 hours ago"
limit=20
follow=0

usage() {
  cat <<'EOF'
Usage: list-rejected-wecom-users.sh [--since TIME] [--limit COUNT] [--follow]

Print only the timestamp and user_id from rejected enterprise WeCom messages.

Options:
  --since TIME   journalctl time expression; default: 24 hours ago
  --limit COUNT  maximum historical rows; default: 20
  --follow       continue watching for new rejected users
  -h, --help     show this help
EOF
}

while (( $# > 0 )); do
  case "$1" in
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
  awk '
    {
      marker = "WeCom sender is not allowed: userid=\""
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
  printf 'TIMESTAMP\tUSER_ID\n'
  journalctl --unit "$service" --since "$since" --follow --output short-iso \
    | extract_rejections
  exit 0
fi

records="$(journalctl --unit "$service" --since "$since" --no-pager --output short-iso \
  | extract_rejections)"
if [[ -z "$records" ]]; then
  printf 'No rejected enterprise WeCom users found since %s.\n' "$since"
  exit 0
fi

mapfile -t rows <<<"$records"
start=0
if (( ${#rows[@]} > limit )); then
  start=$((${#rows[@]} - limit))
fi
printf 'TIMESTAMP\tUSER_ID\n'
for (( index = start; index < ${#rows[@]}; index += 1 )); do
  printf '%s\n' "${rows[index]}"
done
