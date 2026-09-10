# Remote deployment

English | [中文](DEPLOYMENT.zh.md)

This runbook deploys the Trader Ops MVP to one Debian 12 `amd64` host. Harness, OpenViking, and host-native Ollama stay on that host; trusted developers reach Harness through an authenticated private-LAN socket proxy or an SSH tunnel. A public network listener and general-purpose reverse proxy are intentionally outside this MVP.

## Validated target

The first target is the `dsh-server` SSH host. The preflight observed Debian 12, four CPU cores, 7.7 GiB RAM plus swap, 34 GB free disk, systemd, Python 3.11, and outbound access to GitHub, npm, GHCR, Node.js, Ollama, Docker, and AIHubMix. Docker, Node.js, pnpm, Git, and curl were absent before bootstrap. Ports 1933, 3180, and 11434 were unused.

The committed bootstrap pins Node.js 24.20.0, pnpm 11.7.0, Ollama 0.33.3, the two local Ollama models, and the multi-platform OpenViking image digest validated on the development Mac. Docker Engine and Compose come from Docker's signed Debian repository.

## Filesystem and network layout

```text
/opt/deepseek-harness/releases/<git-commit>/  # immutable source and build
/opt/deepseek-harness/current                 # active release symlink
/etc/deepseek-harness/trader-ops.env          # root:root 0600, secrets and environment
/var/lib/deepseek-harness/                    # dsh Profile and runtime state
/var/lib/openviking/                          # root-owned OpenViking config and data
/usr/share/ollama/                            # Ollama service home and model data
/srv/dsh-workspace/                           # agent-accessible workspace
```

Harness and OpenViking listen only on `127.0.0.1:3180` and `127.0.0.1:1933`. Native Ollama listens only on Docker's bridge gateway at port 11434; `host.docker.internal` maps the OpenViking container to that address. When `TRADER_OPS_LAN_HOST` names an IPv4 address owned by the host, a systemd socket binds that one address on port 3180 and `systemd-socket-proxyd` forwards it to Harness. The validated target uses `192.168.4.103:3180`; the configurator rejects wildcard and non-local proxy addresses.

## 1. Bootstrap the Debian host

Copy `scripts/bootstrap-debian-host.sh` to the remote operator's home directory, review it, and run it in an interactive SSH terminal. Name the non-root operator explicitly because `$USER` is `root` inside an existing root shell:

```bash
ssh -t dsh-server \
  'sudo env TRADER_OPS_DEPLOY_OPERATOR=boon bash /home/boon/bootstrap-debian-host.sh'
```

The script validates Debian 12/amd64, refuses conflicting container packages, installs Docker from its signed apt repository, verifies the Node and Ollama downloads, creates the `dsh` and `ollama` service users, configures persistent directories, restricts Ollama to the Docker bridge address, and pulls only these models:

```text
qwen3-embedding:0.6b
guoxuter/ov_intent_analysis_sft:v7_q8
```

The 1.3 GB Ollama runtime and model downloads make this the longest phase. The network download uses HTTP/1.1 with retry and resume support. When the target host has a slow GitHub route, copy the verified archive to it and set `TRADER_OPS_OLLAMA_ARCHIVE=/path/to/ollama-linux-amd64.tar.zst`; the script still enforces the pinned SHA-256. The script is safe to retry after a network failure unless it reports an incomplete or conflicting installation; inspect the exact reported path before changing or removing anything.

## 2. Build and activate an immutable release

Run the release installer as the non-root deployment operator, using the full reviewed commit SHA:

```bash
ssh dsh-server \
  '/home/boon/trader-ops-install-release.sh <40-character-git-commit>'
```

When the host's GitHub route is too slow, create a `git archive` on a trusted machine with a top-level directory and `.trader-ops-source-commit` containing the same full commit SHA. Copy it to the host, calculate its SHA-256, and pass its absolute path through `TRADER_OPS_RELEASE_ARCHIVE` and the digest through `TRADER_OPS_RELEASE_ARCHIVE_SHA256`. The installer verifies both before extracting and building it, and supplies the verified revision as `DSH_CLIENT_COMMIT_HASH` because a source archive has no `.git` directory.

The installer fetches exactly that commit, runs `pnpm install --frozen-lockfile` and `pnpm run build`, records a build marker, and atomically moves `/opt/deepseek-harness/current`. Deployment scripts resolve the repository from their installed path and invoke the built `apps/cli/lib/bin.js` entry directly; the deployment overlay likewise loads its private tool-policy plugin from the current release instead of expecting it in the external Profile. Runtime configuration therefore neither requires release-time Git metadata nor asks pnpm to reconcile the immutable release. The installer does not restart any service. An existing directory without its build marker is treated as an incomplete release and requires inspection instead of automatic deletion.

## 3. Install secrets and start the runtime

Rotate any API key previously pasted into chat or logs. Then run the runtime configurator in an interactive SSH terminal:

```bash
ssh -t dsh-server \
  'sudo env TRADER_OPS_LAN_HOST=192.168.4.103 bash /opt/deepseek-harness/current/deployments/trader-ops/scripts/configure-debian-runtime.sh'
```

Enter the rotated AIHubMix key at the hidden prompt. The script uses `https://api.inferera.com/v1` and `deepseek-v4-flash-0731` by default, generates a separate OpenViking root key, writes the mode-`0600` environment file, starts OpenViking, creates the `trader-ops/remote-admin` tenant identity, stores its narrower user key, installs the pinned DSH plugin, and validates one real remote-model turn with the Trader Ops plugins loaded. It persists an explicitly supplied `TRADER_OPS_LAN_HOST`, declares that authority to Harness through `--trusted-host`, and configures the systemd socket proxy without changing Harness's loopback bind. It then requires either a successful Web response or the expected `401` authentication challenge on both routes and confirms that the systemd restart count remains stable for ten seconds. The Harness unit stops retrying after five startup failures in two minutes.

The configurator is resumable: after the environment file exists it reuses it instead of prompting or overwriting credentials. If the OpenViking account already exists while the tenant key is still absent, it regenerates that one admin key and stores the new value. The root key is never given to Harness.

## 4. Validate and connect

On the server, confirm that Harness and OpenViking use loopback, Ollama uses the Docker bridge, the proxy socket uses the selected private address, and all services are active:

```bash
sudo systemctl --no-pager --full status docker ollama dsh-trader-ops
sudo ss -ltnp | grep -E ':(1933|3180|11434)[[:space:]]'
sudo docker compose --env-file /etc/deepseek-harness/trader-ops.env \
  -f /opt/deepseek-harness/current/deployments/trader-ops/config/openviking/docker-compose.yml ps
sudo docker exec trader-ops-openviking ov doctor
```

From a trusted host on the same private network, open `http://192.168.4.103:3180`. A `401` response without the authenticated URL token is the expected healthy response. If the private route is unavailable, create an SSH tunnel and keep that terminal open:

```bash
ssh -N -L 3180:127.0.0.1:3180 dsh-server
```

Read the current authenticated Web URL from the service journal in another terminal, then replace its host with `127.0.0.1:3180` if necessary and open it locally:

```bash
ssh -t dsh-server 'sudo journalctl -u dsh-trader-ops -n 100 --no-pager'
```

The URL token grants browser access to this process. Do not paste it into chat or retain it in shared logs.

## 5. Enable the optional enterprise WeCom channel

Create an intelligent bot in the enterprise WeCom administration console and enable long-connection receiving. Collect its BotID and secret, plus the exact WeCom user ids allowed to start Agent turns. Stop every other process that uses this BotID before cutover because WeCom permits one active long connection for each bot.

Run the dedicated configurator in an interactive root terminal:

```bash
ssh -t dsh-server \
  'sudo bash /opt/deepseek-harness/current/deployments/trader-ops/scripts/configure-wecom-runtime.sh --enable'
```

The configurator reads the bot secret through a hidden prompt, generates and preserves a separate Session identity key, rejects wildcard allowlists, installs the channel package and its unattended preset, and restarts the existing `dsh-trader-ops` service. It keeps Harness on loopback and opens no new inbound port. The channel uses `read-only` sandbox access with `approval: never`; its preset disables `tool-ask-user`, suppresses the generic Harness identity, and identifies itself as `我是CFI 股票交易组的 AI Agent 智能助手`. If activation fails, the script restores the previous environment and restarts the base Trader Ops service.

An empty group-chat list keeps group access disabled. Enable a reviewed group later by placing its exact chat id in `WECOM_ALLOWED_CHATS`; never use `*`. Validate the initial single chat from one allowed user with:

To discover a non-admitted employee's exact `userid`, ask the employee to send one message and inspect only rejection warnings:

```bash
sudo journalctl -u dsh-trader-ops --since '10 minutes ago' --no-pager \
  | grep -F 'WeCom sender is not allowed'
```

The JSON-quoted `userid` is employee identity data. Restrict journal access and retention, and never copy message content or unrelated journal entries into an allowlist ticket.

```text
Production verification: reply only PROD-PONG.
```

The bot must send the processing message and then `PROD-PONG` without a service restart. Inspect status without sharing the journal because the Web startup URL contains its authentication token:

```bash
sudo systemctl show dsh-trader-ops -p ActiveState -p SubState -p NRestarts
sudo journalctl -u dsh-trader-ops -n 100 --no-pager
```

Disable the channel while retaining its credentials and conversation identity material:

```bash
sudo bash /opt/deepseek-harness/current/deployments/trader-ops/scripts/configure-wecom-runtime.sh --disable
```

Before production approval, complete the channel-owned [Linux acceptance procedure](../../docs/user/guide/wecom-linux-deployment.md#acceptance-procedure), including Session continuity, sandbox confinement, allowlist rejection, restart recovery, and journal privacy.

## Each release

1. Run `install-debian-release.sh` with a new reviewed full commit SHA.
2. Load `/etc/deepseek-harness/trader-ops.env`, then run `bootstrap-profile.sh` and `verify-deployment.sh` as `dsh` against the new release before restarting the service; these commands preserve the optional WeCom dependency and unattended preset.
3. Back up `/var/lib/openviking` and `/var/lib/deepseek-harness` before any data migration.
4. Restart `dsh-trader-ops`, repeat the listener, health, empty-skill, and empty-knowledge checks, and retain the previous release.
5. On failure, atomically point `current` to the previous validated release and restart Harness. Restore persistent data only when the failed release performed an explicit incompatible migration.

## Pre-production gates

- OpenViking `/health` and `/ready` succeed, `ov doctor` passes, and data survives a container restart.
- `dsh --dump-config` contains exactly one expected `openviking-memory-runtime` and includes `trader-ops-tool-policy`, `trader-ops-skills`, and the AIHubMix provider.
- The real environment contains no template or exposed credentials, and secrets do not appear in Git, logs, process arguments, or shell history.
- AIHubMix endpoint ownership, model routing, retention, and data-processing terms are approved for every class of model-visible data.
- Harness stays read-only and is limited to the trusted private developer network or an SSH tunnel while business knowledge, production skills, trusted user identity, durable approval, and the Trader Ops MCP authorization layer are absent.
- `tool-access.yaml` loads with `enforced: true`, an explicit environment, and default deny. The future business MCP server must repeat actor-, resource-, and argument-level authorization.
- When WeCom is enabled, the bot uses exact user and chat allowlists, one active BotID owner, the `trader-ops-wecom` unattended preset, and the confined noninteractive permission preset. An allowed single-chat message completes through the real remote model before approval.

## Backup and monitoring

Backups cover at least `/var/lib/openviking`, `/var/lib/deepseek-harness`, `/etc/deepseek-harness`, and future external approval or audit stores. Monitoring covers OpenViking health/readiness, the Harness and Ollama services, plugin connection failures, recall latency, disk capacity, and future MCP tool failures. Automated recovery must never replay non-idempotent business writes.
