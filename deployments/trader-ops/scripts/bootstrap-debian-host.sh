#!/usr/bin/env bash
set -euo pipefail

node_version="${TRADER_OPS_NODE_VERSION:-24.20.0}"
pnpm_version="${TRADER_OPS_PNPM_VERSION:-11.7.0}"
ollama_version="${TRADER_OPS_OLLAMA_VERSION:-0.33.3}"
ollama_sha256="${TRADER_OPS_OLLAMA_SHA256:-c13cea8f3389db4145f8a6cb88d1747242a48639d7c13e3bda7c1ebdc6eebb2f}"
deploy_operator="${TRADER_OPS_DEPLOY_OPERATOR:-${SUDO_USER:-}}"

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this host bootstrap as root through sudo.\n' >&2
  exit 1
fi

# The operating-system file is a root-owned input on the supported host.
# shellcheck source=/dev/null
source /etc/os-release
if [[ "${ID:-}" != debian || "${VERSION_ID:-}" != 12 ]]; then
  printf 'Unsupported host: expected Debian 12, found %s %s.\n' "${ID:-unknown}" "${VERSION_ID:-unknown}" >&2
  exit 1
fi
if [[ "$(dpkg --print-architecture)" != amd64 ]]; then
  printf 'Unsupported architecture: expected amd64.\n' >&2
  exit 1
fi
if [[ -z "$deploy_operator" || "$deploy_operator" == root ]] || ! id "$deploy_operator" >/dev/null 2>&1; then
  printf 'Set TRADER_OPS_DEPLOY_OPERATOR to an existing non-root deployment user.\n' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y bubblewrap build-essential ca-certificates curl git gnupg openssl python3 xz-utils zstd

conflicts=()
for package in docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    conflicts+=("$package")
  fi
done
if (( ${#conflicts[@]} > 0 )); then
  printf 'Conflicting container packages are installed: %s\n' "${conflicts[*]}" >&2
  printf 'Review and remove them explicitly before rerunning this script.\n' >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

install -m 0755 -d /etc/apt/keyrings
curl --fail --show-error --silent --location \
  https://download.docker.com/linux/debian/gpg \
  --output "$tmp_dir/docker.asc"
install -m 0644 "$tmp_dir/docker.asc" /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

node_archive="node-v${node_version}-linux-x64.tar.xz"
node_url="https://nodejs.org/download/release/v${node_version}"
curl --fail --show-error --silent --location "$node_url/$node_archive" --output "$tmp_dir/$node_archive"
curl --fail --show-error --silent --location "$node_url/SHASUMS256.txt" --output "$tmp_dir/SHASUMS256.txt"
(
  cd "$tmp_dir"
  grep "  ${node_archive}$" SHASUMS256.txt | sha256sum --check -
)
node_root="/opt/node-v${node_version}-linux-x64"
if [[ ! -x "$node_root/bin/node" ]]; then
  if [[ -e "$node_root" ]]; then
    printf 'Incomplete Node installation exists at %s; inspect it before retrying.\n' "$node_root" >&2
    exit 1
  fi
  tar -xJf "$tmp_dir/$node_archive" -C /opt
fi
ln -sfn "$node_root/bin/node" /usr/local/bin/node
ln -sfn "$node_root/bin/npm" /usr/local/bin/npm
ln -sfn "$node_root/bin/npx" /usr/local/bin/npx
"$node_root/bin/npm" --prefix "$node_root" install --global "pnpm@$pnpm_version"
ln -sfn "$node_root/bin/pnpm" /usr/local/bin/pnpm

installed_ollama_version=""
if command -v ollama >/dev/null 2>&1; then
  installed_ollama_version="$(ollama --version 2>/dev/null | sed -n 's/^ollama version is //p')"
fi
if [[ -n "$installed_ollama_version" && "$installed_ollama_version" != "$ollama_version" ]]; then
  printf 'Ollama %s is already installed; expected %s. Review the upgrade before retrying.\n' \
    "$installed_ollama_version" "$ollama_version" >&2
  exit 1
fi
if [[ -z "$installed_ollama_version" ]]; then
  ollama_archive="ollama-linux-amd64.tar.zst"
  curl --fail --show-error --location \
    "https://github.com/ollama/ollama/releases/download/v${ollama_version}/${ollama_archive}" \
    --output "$tmp_dir/$ollama_archive"
  printf '%s  %s\n' "$ollama_sha256" "$tmp_dir/$ollama_archive" | sha256sum --check -
  tar --use-compress-program=unzstd -xf "$tmp_dir/$ollama_archive" -C /usr
fi

if ! id dsh >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/deepseek-harness \
    --create-home --shell /usr/sbin/nologin dsh
fi
if ! id ollama >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /usr/share/ollama \
    --create-home --shell /usr/sbin/nologin ollama
fi

install -d -o "$deploy_operator" -g dsh -m 2750 /opt/deepseek-harness
install -d -o "$deploy_operator" -g dsh -m 2750 /opt/deepseek-harness/releases
install -d -o root -g root -m 0700 /etc/deepseek-harness
install -d -o dsh -g dsh -m 0700 /var/lib/deepseek-harness
install -d -o root -g root -m 0700 /var/lib/openviking
install -d -o dsh -g dsh -m 0750 /srv/dsh-workspace

docker_gateway="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
if [[ -z "$docker_gateway" ]]; then
  printf 'Docker bridge has no IPv4 gateway.\n' >&2
  exit 1
fi
cat >/etc/systemd/system/ollama.service <<EOF
[Unit]
Description=Ollama Service
Wants=network-online.target
After=network-online.target docker.service

[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="OLLAMA_HOST=${docker_gateway}:11434"

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ollama

for _ in {1..60}; do
  if curl --fail --silent --show-error "http://${docker_gateway}:11434/api/tags" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error "http://${docker_gateway}:11434/api/tags" >/dev/null
OLLAMA_HOST="http://${docker_gateway}:11434" ollama pull qwen3-embedding:0.6b
OLLAMA_HOST="http://${docker_gateway}:11434" ollama pull guoxuter/ov_intent_analysis_sft:v7_q8

docker version >/dev/null
docker compose version >/dev/null
node --version
pnpm --version
ollama --version
printf 'Docker bridge gateway: %s\n' "$docker_gateway"
printf 'Host bootstrap complete. Harness and OpenViking remain stopped until a release and secrets are installed.\n'
