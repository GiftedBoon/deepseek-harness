#!/usr/bin/env bash
set -euo pipefail

git_ref="${1:-}"
repository_url="${TRADER_OPS_REPOSITORY_URL:-https://github.com/GiftedBoon/deepseek-harness.git}"
release_archive="${TRADER_OPS_RELEASE_ARCHIVE:-}"
release_archive_sha256="${TRADER_OPS_RELEASE_ARCHIVE_SHA256:-}"

if [[ "$(id -u)" -eq 0 ]]; then
  printf 'Run this release installer as the non-root deployment operator.\n' >&2
  exit 1
fi
if [[ ! "$git_ref" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Usage: %s <full-40-character-git-commit>\n' "$0" >&2
  exit 1
fi
if [[ -n "$release_archive" ]]; then
  if [[ ! -f "$release_archive" ]]; then
    printf 'TRADER_OPS_RELEASE_ARCHIVE is not a regular file: %s\n' "$release_archive" >&2
    exit 1
  fi
  if [[ ! "$release_archive_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    printf 'TRADER_OPS_RELEASE_ARCHIVE_SHA256 must be the archive SHA-256.\n' >&2
    exit 1
  fi
elif [[ -n "$release_archive_sha256" ]]; then
  printf 'TRADER_OPS_RELEASE_ARCHIVE_SHA256 requires TRADER_OPS_RELEASE_ARCHIVE.\n' >&2
  exit 1
fi

release_root="/opt/deepseek-harness/releases"
release_dir="$release_root/$git_ref"
build_marker="$release_dir/.trader-ops-built"

if [[ -e "$release_dir" && ! -f "$build_marker" ]]; then
  printf 'Incomplete release exists at %s; inspect it before retrying.\n' "$release_dir" >&2
  exit 1
fi

if [[ ! -f "$build_marker" ]]; then
  install -d -m 2750 "$release_dir"
  if [[ -n "$release_archive" ]]; then
    printf '%s  %s\n' "$release_archive_sha256" "$release_archive" | sha256sum --check -
    tar --extract --gzip --file "$release_archive" --directory "$release_dir" --strip-components=1
    archive_commit_file="$release_dir/.trader-ops-source-commit"
    if [[ ! -f "$archive_commit_file" ]] || [[ "$(<"$archive_commit_file")" != "$git_ref" ]]; then
      printf 'Release archive does not declare revision %s.\n' "$git_ref" >&2
      exit 1
    fi
  else
    git -C "$release_dir" init
    git -C "$release_dir" remote add origin "$repository_url"
    git -C "$release_dir" fetch --depth 1 origin "$git_ref"
    git -C "$release_dir" checkout --detach FETCH_HEAD
    if [[ "$(git -C "$release_dir" rev-parse HEAD)" != "$git_ref" ]]; then
      printf 'Fetched revision does not match %s.\n' "$git_ref" >&2
      exit 1
    fi
  fi
  (
    cd "$release_dir"
    CI=true pnpm install --frozen-lockfile
    pnpm run build
  )
  printf '%s\n' "$git_ref" >"$build_marker"
fi

next_link="/opt/deepseek-harness/.current-next"
ln -sfn "releases/$git_ref" "$next_link"
mv -Tf "$next_link" /opt/deepseek-harness/current
printf 'Activated built release %s. Services have not been restarted.\n' "$git_ref"
