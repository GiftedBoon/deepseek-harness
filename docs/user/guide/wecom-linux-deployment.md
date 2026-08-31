---
description: "Production Linux deployment and acceptance procedure for a persistent DeepSeek Harness enterprise WeCom intelligent-bot channel."
---

# Deploy the enterprise WeCom Agent on Linux

English | [中文](wecom-linux-deployment.zh.md)

## Summary

This guide deploys one enterprise WeCom intelligent bot as a persistent DeepSeek Harness Agent on a company Linux host. The deployment pins one repository revision, keeps runtime data outside the release tree, stores credentials outside Git, and runs the dedicated `wecom` profile under systemd. One BotID permits only one active process, so production cutover must stop the previous host before Linux starts. The Linux deployment operator owns every host-specific command and must complete the acceptance procedure on the target host before the release is approved.

## Table of Contents

- [Deployment outcome](#deployment-outcome)
- [Prerequisites](#prerequisites)
- [Prepare the release](#prepare-the-release)
- [Prepare the Linux host](#prepare-the-linux-host)
- [Install and build DSH](#install-and-build-dsh)
- [Create the WeCom profile](#create-the-wecom-profile)
- [Configure credentials](#configure-credentials)
- [Install the systemd service](#install-the-systemd-service)
- [Cut over the BotID](#cut-over-the-botid)
- [Acceptance procedure](#acceptance-procedure)
- [Operations and rollback](#operations-and-rollback)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="deployment-outcome"></a>
## Deployment outcome

The completed deployment has one dedicated operating-system user, one immutable source release, one persistent Harness home, one confined Agent workspace, one root-owned credential file, and one systemd service. The Web management endpoint listens on loopback only; enterprise WeCom reaches the Agent through the outbound WebSocket connection and needs no inbound callback URL.

Use this directory layout:

```text
/opt/deepseek-harness/
├── releases/<release-ref>/
└── current -> releases/<release-ref>/

/var/lib/deepseek-harness/
/srv/dsh-workspace/
/etc/deepseek-harness/wecom.env
/etc/systemd/system/dsh-wecom.service
```

The `dsh` user owns `/var/lib/deepseek-harness` and `/srv/dsh-workspace`. Root owns the release directories, credential file, and systemd unit after installation.

<a id="prerequisites"></a>
## Prerequisites

Collect these inputs before the maintenance window:

- A repository commit or tag that contains `packages/channel/channel-wecom` and all associated generated documents.
- A Linux x64 or arm64 host with Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.7.0`.
- Git, Python 3, a C/C++ build toolchain, CA certificates, and `bubblewrap` where the distribution supports it.
- Outbound TLS access to the model endpoint and `openws.work.weixin.qq.com:443`.
- The enterprise WeCom BotID and bot secret.
- An explicit list of admitted enterprise WeCom user ids and, when group chat is enabled, admitted chat ids.
- A model credential and a verified provider/model route.
- A high-entropy `WECOM_SESSION_KEY` stored separately from the bot secret.

Do not use a wildcard allowlist in production. Do not expose port 3180 through a reverse proxy unless browser administration is a separate reviewed requirement.

### Choose a migration mode

A clean deployment creates new channel mappings and does not copy old Session history. Generate a new `WECOM_SESSION_KEY` for this mode.

A continuity deployment preserves the existing `WECOM_SESSION_KEY` and migrates the persistent Harness data from the previous host. Use the exact same repository revision on both hosts during migration because this pre-release project does not promise compatibility between different on-disk versions. Back up the complete source Harness home before migration, rebuild the Linux profile instead of copying its `node_modules`, and rewrite every host-specific absolute path.

<a id="prepare-the-release"></a>
## Prepare the release

Commit the complete change to the company repository before deployment. Do not deploy an uncommitted workstation tree.

```sh
git status --short
git add <reviewed-paths>
git commit -m "feat: add production WeCom agent channel"
git push origin <branch>
git tag <release-ref>
git push origin <release-ref>
```

Record the release commit for the change ticket:

```sh
git rev-parse <release-ref>
```

The reviewer must confirm that the commit contains no `.env` file, bot secret, model key, Session identity key, real BotID, real user id, or workstation-only absolute path.

<a id="prepare-the-linux-host"></a>
## Prepare the Linux host

The following package command is an Ubuntu or Debian example. The Linux operator must translate package names for another distribution and record the installed versions.

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential python3 bubblewrap
```

Install a supported Node.js release through the company's approved package source. Enable the repository pnpm version through Corepack:

```sh
node --version
sudo corepack enable
sudo corepack prepare pnpm@11.7.0 --activate
pnpm --version
command -v pnpm
```

Create the service account and persistent directories:

```sh
sudo useradd --system --create-home --shell /bin/bash dsh
sudo mkdir -p /opt/deepseek-harness/releases
sudo mkdir -p /var/lib/deepseek-harness
sudo mkdir -p /srv/dsh-workspace
sudo mkdir -p /etc/deepseek-harness
sudo chown -R dsh:dsh /var/lib/deepseek-harness /srv/dsh-workspace
sudo chmod 700 /var/lib/deepseek-harness
```

Verify DNS and outbound TLS from the target network:

```sh
getent hosts openws.work.weixin.qq.com
openssl s_client -connect openws.work.weixin.qq.com:443 -servername openws.work.weixin.qq.com </dev/null
```

The TLS command must complete a certificate handshake. A firewall, proxy, certificate, or DNS failure blocks deployment.

<a id="install-and-build-dsh"></a>
## Install and build DSH

Clone the immutable release into its own directory and publish it through the `current` symlink:

```sh
sudo git clone --branch <release-ref> --depth 1 <company-repository-url> /opt/deepseek-harness/releases/<release-ref>
sudo chown -R dsh:dsh /opt/deepseek-harness/releases/<release-ref>
sudo ln -sfn /opt/deepseek-harness/releases/<release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
git rev-parse HEAD
```

The observed `HEAD` must equal the commit recorded in the change ticket. Install the locked dependency graph and build the repository:

```sh
sudo -u dsh env CI=true pnpm install --frozen-lockfile
sudo -u dsh pnpm run build
```

Run the channel-owned tests and typecheck before profile configuration:

```sh
sudo -u dsh ./node_modules/.bin/vitest run packages/channel/channel-wecom/tests
sudo -u dsh ./node_modules/.bin/tsc -p packages/channel/channel-wecom/tsconfig.json --noEmit
```

All channel tests must pass, and the typecheck must exit with status 0. Stop the deployment if either command fails.

Make the built release read-only to the service account after the checks pass:

```sh
sudo chown -R root:root /opt/deepseek-harness/releases/<release-ref>
```

<a id="create-the-wecom-profile"></a>
## Create the WeCom profile

Set the production Harness home and add the channel package as a profile dependency. This command installs the package; the later `cordis.patch.yml` entry mounts the Cordis plugin.

```sh
cd /opt/deepseek-harness/current
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom add ./packages/channel/channel-wecom
```

Set `/var/lib/deepseek-harness/profiles/wecom/package.json` to use the base and Web application bundles with startup-only patch loading. Keep the dependency value generated on the Linux host.

```json
{
  "name": "dsh-profile-wecom",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-channel-wecom": "link:/opt/deepseek-harness/current/packages/channel/channel-wecom"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ],
      "patchReload": "startup"
    }
  }
}
```

### Create the unattended preset

Copy the shipped standard preset into the production profile:

```sh
sudo -u dsh mkdir -p /var/lib/deepseek-harness/profiles/wecom/agent-presets
sudo -u dsh cp -R packages/preset/agent-presets/presets/standard /var/lib/deepseek-harness/profiles/wecom/agent-presets/standard
```

In the copied `agent.cordis.yml`, replace the persona text with a fixed unattended-channel instruction and disable the `tool-ask-user` row. The resulting entries must include these values:

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent serving an unattended enterprise WeCom text channel. Answer directly and never request interactive input.

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  disabled: true
```

Set the copied `preset.yml` metadata:

```yaml
name: Enterprise WeCom unattended mode
description: Standard coding tools without interactive questions for the enterprise WeCom long-connection channel.
order: 1
```

### Create the production patch

Create `/var/lib/deepseek-harness/profiles/wecom/cordis.patch.yml`. Replace every placeholder before validation.

```yaml
- id: modules
  disabled: true

- id: client-hmr
  disabled: true

- id: agent-presets
  name: '@deepseek-ai/dsh-agent-presets'
  config:
    default: standard
    roots:
      - path: '/var/lib/deepseek-harness/profiles/wecom/agent-presets'
        trust: system
    includeShippedRoot: false
    includeUserRoot: false

- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      wecom-channel:
        sandbox: workspace-write
        approval: never

- insert:
    - id: channel-wecom
      name: '@deepseek-ai/dsh-channel-wecom'
      config:
        botId: '<wecom-bot-id>'
        secretEnv: WECOM_BOT_SECRET
        sessionKeyEnv: WECOM_SESSION_KEY
        workspacePath: '/srv/dsh-workspace'
        agentPreset: standard
        permissionPreset: wecom-channel
        allowedUsers:
          - '<admitted-user-id>'
        allowedChats: []
        groupConversationMode: shared
        messages:
          processing: '正在处理…'
          timeout: '处理超时，请稍后重试。'
          failure: '处理失败，请稍后重试。'
          emptyReply: '任务已完成，但没有文本回复。'
          unauthorized: '当前用户或会话未获授权。'
          duplicate: '该消息正在处理中。'
```

Use `allowedChats: []` until group access is separately approved. Add exact group ids instead of `"*"` when group access is enabled.

Protect the profile files:

```sh
sudo chown -R dsh:dsh /var/lib/deepseek-harness/profiles/wecom
sudo chmod -R go-rwx /var/lib/deepseek-harness/profiles/wecom
```

<a id="configure-credentials"></a>
## Configure credentials

Create `/etc/deepseek-harness/wecom.env` without shell exports or spaces around `=`. Use the credential names required by the selected model provider.

```dotenv
DEEPSEEK_API_KEY=<production-model-key>
# DEEPSEEK_BASE_URL=<company-model-gateway-url>
WECOM_BOT_SECRET=<wecom-bot-secret>
WECOM_SESSION_KEY=<stable-high-entropy-session-key>
```

Generate a Session identity key only for a clean deployment:

```sh
openssl rand -hex 32
```

Set ownership and permissions:

```sh
sudo chown root:dsh /etc/deepseek-harness/wecom.env
sudo chmod 640 /etc/deepseek-harness/wecom.env
```

Validate the effective profile without putting secrets on the command line or printing the expanded configuration:

```sh
sudo -u dsh bash -lc '
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  export DSH_HOME=/var/lib/deepseek-harness
  cd /opt/deepseek-harness/current
  pnpm dsh --profile wecom --dump-config >/dev/null
'
```

The command must exit with status 0. Resolve missing credentials, unknown packages, invalid preset roots, and invalid absolute paths before continuing.

Validate the model independently before the BotID cutover:

```sh
sudo -u dsh bash -lc '
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  export DSH_HOME=/var/lib/deepseek-harness
  cd /opt/deepseek-harness/current
  pnpm dsh --profile headless "Reply only MODEL-OK"
'
```

The final output must contain `MODEL-OK`. A passing configuration dump does not replace this real model request.

<a id="install-the-systemd-service"></a>
## Install the systemd service

Confirm the system-wide pnpm path with `command -v pnpm`, then create `/etc/systemd/system/dsh-wecom.service`. Replace `/usr/local/bin/pnpm` when the observed path differs.

```systemd
[Unit]
Description=DeepSeek Harness enterprise WeCom Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh
Group=dsh
WorkingDirectory=/opt/deepseek-harness/current
Environment=DSH_HOME=/var/lib/deepseek-harness
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/etc/deepseek-harness/wecom.env
ExecStart=/usr/local/bin/pnpm dsh --profile wecom --port 3180 --no-open
Restart=always
RestartSec=10
TimeoutStopSec=30
UMask=0077
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/deepseek-harness /srv/dsh-workspace

[Install]
WantedBy=multi-user.target
```

Validate and enable the unit without starting it before the previous BotID owner stops:

```sh
sudo systemd-analyze verify /etc/systemd/system/dsh-wecom.service
sudo systemctl daemon-reload
sudo systemctl enable dsh-wecom
```

Do not add `PrivateUsers=true`; the Linux sandbox selects `bubblewrap` or Landlock and must probe the target kernel and user-namespace policy. The workspace acceptance test below is the deployment evidence for the selected sandbox backend.

<a id="cut-over-the-botid"></a>
## Cut over the BotID

Schedule one maintenance window because enterprise WeCom permits only one active process for a BotID. Stop the current owner before Linux starts.

On a macOS host managed by the documented LaunchAgent:

```sh
launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/com.deepseek-harness.wecom.plist"
```

Confirm that the old process and its outbound connection have stopped. Then start Linux:

```sh
sudo systemctl start dsh-wecom
sudo systemctl status dsh-wecom --no-pager
```

Do not restart the previous host while Linux owns the BotID. Remove or disable its automatic-start registration after acceptance.

-----

<a id="acceptance-procedure"></a>
## Acceptance procedure

The Linux deployment operator records every result against the release commit. A failed mandatory check blocks production approval.

### 1. Process and restart state

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p NRestarts
sudo journalctl -u dsh-wecom -n 200 --no-pager
```

Pass when the service is `active` and `running`, `NRestarts` is stable, and the journal has no credential, profile, preset, workspace, sandbox, or authentication failure.

### 2. Local listener and outbound connection

```sh
curl -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:3180/
sudo ss -ltnp | grep ':3180'
sudo ss -tpn | grep ':443'
```

Pass when the unauthenticated HTTP request returns `401`, port 3180 listens only on loopback, and the service owns a stable outbound TLS connection. Do not open port 3180 in the host or network firewall for this channel-only deployment.

### 3. Authorized conversation

An admitted user sends this unique message in a direct conversation:

```text
Production verification: reply only PROD-PONG.
```

Pass when WeCom first displays the configured processing text and then displays `PROD-PONG` before `turnTimeoutMs`. Confirm that the systemd service did not restart during the turn.

### 4. Session continuity

The same user sends these messages in order:

```text
Remember verification code 7391 and reply only REMEMBERED.
```

```text
What verification code did I ask you to remember?
```

Pass when the second answer contains `7391`. This verifies stable conversation mapping, persisted Session history, Agent resume, and resumed provider/model selection.

### 5. Confined workspace write

The admitted user sends:

```text
Create deployment-smoke.txt in the workspace with the exact content wecom-linux-ok, then report the result.
```

Verify the file on Linux:

```sh
sudo -u dsh test "$(cat /srv/dsh-workspace/deployment-smoke.txt)" = "wecom-linux-ok"
```

Pass when the file exists with the exact content. Run a separately approved negative test that asks the Agent to write outside `/srv/dsh-workspace`; pass only when the sandbox refuses the write and no file appears outside the workspace.

### 6. Admission policy

Test an admitted direct user, one non-admitted user, and one non-admitted group when test identities are available. Pass when the admitted user can converse and every other sender receives the configured unauthorized response without starting a model turn.

### 7. Restart recovery

```sh
sudo systemctl restart dsh-wecom
sudo systemctl status dsh-wecom --no-pager
```

After reconnection, the admitted user asks for verification code 7391 again. Pass when the service returns the remembered value and the journal contains no persistence or authentication failure.

### 8. Supervisor recovery

```sh
sudo systemctl kill --signal=SIGTERM dsh-wecom
sleep 15
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p NRestarts
```

Pass when systemd starts a replacement process, the service returns to `active` and `running`, and a new WeCom message completes normally.

### 9. Log privacy

Review the service journal after all tests. Pass when it contains no model credential, bot secret, Session identity key, accepted raw message text, raw provider user id, or provider debug frame.

### Acceptance record

Record these fields in the release ticket:

| Field | Required evidence |
|---|---|
| Release | Git commit and tag |
| Host | Linux distribution, kernel, architecture, Node, and pnpm versions |
| Service | `ActiveState`, `SubState`, and stable `NRestarts` |
| Network | Loopback-only 3180 and established outbound TLS |
| Model | `MODEL-OK` headless request |
| WeCom | Processing response and final `PROD-PONG` |
| Persistence | Code 7391 survives service restart |
| Sandbox | Workspace write succeeds and outside write fails |
| Admission | Exact allowlist accepts and rejects as configured |
| Privacy | Journal review finds no secret or accepted raw message data |

<a id="operations-and-rollback"></a>
## Operations and rollback

Use systemd as the only process owner:

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl restart dsh-wecom
sudo systemctl stop dsh-wecom
sudo journalctl -u dsh-wecom -f
```

Back up `/var/lib/deepseek-harness` and `/etc/deepseek-harness/wecom.env` through the company's encrypted backup system. The backup access policy must treat `WECOM_SESSION_KEY`, model credentials, and the bot secret as production secrets.

### Upgrade

Build and test each release in a new `/opt/deepseek-harness/releases/<release-ref>` directory. Stop the service, update `/opt/deepseek-harness/current`, reconcile the profile dependency against the new release, run the configuration and model checks, then start the service and repeat the acceptance procedure.

### Rollback

Stop the service before changing the release symlink:

```sh
sudo systemctl stop dsh-wecom
sudo ln -sfn /opt/deepseek-harness/releases/<previous-release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
sudo -u dsh env DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom install
sudo systemctl start dsh-wecom
```

Do not roll an existing persistent data directory back across an incompatible schema or Session format. Restore the matching pre-upgrade backup when the release notes or change review identifies an on-disk format change.

<a id="security-checklist"></a>
## Security checklist

- The service runs as `dsh`, not root.
- Git and logs contain no credential values or real provider identifiers.
- `/etc/deepseek-harness/wecom.env` is `root:dsh` mode `0640` or stricter.
- The profile uses exact `allowedUsers` and `allowedChats` entries; neither list contains `"*"`.
- The WeCom permission preset uses `workspace-write` or `read-only`, `approval: never`, and never `danger-full-access`.
- The unattended preset disables `tool-ask-user`.
- The workspace is an existing absolute directory owned by `dsh`.
- Port 3180 stays on loopback and closed to the network.
- The host allows outbound TLS only to the approved model and enterprise WeCom destinations required by the deployment.
- Only one active process uses the BotID.
- The backup preserves the Session identity key and persistent data under the same production access controls.

<a id="troubleshooting"></a>
## Troubleshooting

- **The service enters a restart loop** — inspect `systemctl status` and the first journal error; fix the profile, executable path, credential file permission, or absolute directory instead of increasing `RestartSec`.
- **Authentication times out** — verify the BotID and bot secret, stop every other process that uses the BotID, and test DNS and outbound TLS to the enterprise WeCom endpoint.
- **The user sees only the processing response** — inspect model connectivity and `turnTimeoutMs`; verify that the configured provider and model complete the headless model test.
- **The user sees the timeout response** — inspect the correlated Agent failure and tool duration; the configured timeout is a final deadline, not a retry policy.
- **A resumed conversation has no model** — confirm the deployment includes the channel resume fix and runs the recorded release commit.
- **A tool reports `SANDBOX_UNAVAILABLE`** — verify `bubblewrap`, user namespaces, and Landlock support on the target kernel; do not switch the channel to `danger-full-access`.
- **A second host disconnects the service** — locate and stop the other process that uses the BotID; this channel has no leader election.
- **The old conversation is missing** — confirm that the continuity deployment preserved both `WECOM_SESSION_KEY` and the matching persistent Harness data.

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise WeCom channel reference](../../../packages/channel/channel-wecom/README.md) — configuration fields, delivery lifecycle, security, and known limitations.
- [Configure models](providers.md) — provider credentials, custom gateways, model selection, and compatibility settings.
- [Application profiles](../../../packages/boot/app-boot/README.md) — profile directories, bundle composition, and patch loading.
- [Linux sandbox provider](../../../packages/sandbox/sandbox-local/README.md) — `bubblewrap`, Landlock, enforcement, and failure behavior.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Non-authoritative working context</summary>

None.

</details>
