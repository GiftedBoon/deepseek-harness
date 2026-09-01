---
description: "Records the release, host configuration, verification evidence, operating commands, and open items for the WeCom Harness Linux production instance deployed on 2026-09-01."
---

# WeCom Linux production deployment record

English | [中文](wecom-linux-production-record.zh.md)

## Summary

This page records the WeCom Harness deployment completed on host `debian` on 2026-09-01. The service starts from a fixed Git tag and uses a dedicated system account, persistent data directory, confined workspace, root-owned credential file, and systemd supervision. The record contains no BotID, WeCom user or chat ID, API key, bot secret, Session key, or Web administration token. The [WeCom Linux deployment guide](wecom-linux-deployment.md) remains authoritative for the general procedure and configuration fields.

## Table of Contents

- [Deployment identity](#deployment-identity)
- [Host and runtime](#host-and-runtime)
- [Directories and permissions](#directories-and-permissions)
- [Profile configuration](#profile-configuration)
- [Credentials and model](#credentials-and-model)
- [systemd service](#systemd-service)
- [Acceptance results](#acceptance-results)
- [Open items](#open-items)
- [Routine operations](#routine-operations)
- [Upgrade and rollback](#upgrade-and-rollback)
- [Security constraints](#security-constraints)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="deployment-identity"></a>
## Deployment identity

This instance is a fresh deployment and does not migrate old Session data. The following identifiers locate the immutable source release that runs in production.

| Item | Value |
|---|---|
| Deployment date | `2026-09-01` |
| Release tag | `wecom-prod-2026-09-01` |
| Git commit | `de30d099356043e6d034c12d8715e6e7377eb659` |
| Release directory | `/opt/deepseek-harness/releases/wecom-prod-2026-09-01` |
| Current release link | `/opt/deepseek-harness/current` |
| Service name | `dsh-wecom.service` |
| Profile | `wecom` |

`/opt/deepseek-harness/current` resolves to the release directory in the table. The release directory is owned by `root:root` after its build and tests complete.

<a id="host-and-runtime"></a>
## Host and runtime

The production process uses Node and pnpm from the system path. It does not depend on the login user's Conda or NVM environment.

| Item | Verified value |
|---|---|
| Operating system | Debian GNU/Linux 12 (bookworm) |
| Kernel | `6.1.0-18-amd64` |
| Architecture | `x86_64` |
| Node.js | `v24.15.0` at `/usr/local/bin/node` |
| Corepack | System installation accessible to the `dsh` user |
| pnpm | `11.7.0` at `/usr/local/bin/pnpm` |
| GCC | `12.2.0` |
| bubblewrap | `0.8.0` |
| Service account | `dsh`, UID `999`, GID `996` |

DNS resolves `openws.work.weixin.qq.com`, and a TLS handshake to destination port `443` returns `Verification: OK`. The running Node process maintains an outbound TLS connection to the WeCom endpoint.

<a id="directories-and-permissions"></a>
## Directories and permissions

The source release, runtime data, workspace, and credentials are separate. The service can write only to the persistent Harness home and workspace.

| Path | Owner | Mode | Purpose |
|---|---|---|---|
| `/opt/deepseek-harness/releases/wecom-prod-2026-09-01` | `root:root` | Read-only permissions of the release content | Fixed source and build artifacts |
| `/opt/deepseek-harness/current` | root-managed symbolic link | Not applicable | Points to the current release directory |
| `/var/lib/deepseek-harness` | `dsh:dsh` | `0700` | Profile, Sessions, settings, and runtime data |
| `/srv/dsh-workspace` | `dsh:dsh` | `0700` | The only workspace writable by the Agent |
| `/etc/deepseek-harness` | `root:dsh` | `0750` | Credential directory; group permission lets the service account traverse it |
| `/etc/deepseek-harness/wecom.env` | `root:dsh` | `0640` | Model and WeCom credentials |
| `/etc/systemd/system/dsh-wecom.service` | `root:root` | Default system unit permissions | systemd service definition |

The `dsh` account must have traverse permission on `/etc/deepseek-harness`. Otherwise, the service receives `EACCES` even when `wecom.env` is `root:dsh 0640`.

<a id="profile-configuration"></a>
## Profile configuration

The profile is at `/var/lib/deepseek-harness/profiles/wecom`. Its `package.json` composes `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` and sets `patchReload: startup`.

The channel dependency uses a local link into the release directory. An upgrade must run `dsh plugin --profile wecom install` to reconcile this link against the new release.

The copied `standard` preset uses a fixed unattended persona and disables `@deepseek-ai/dsh-tool-ask-user`. The channel uses the `wecom-channel` permission preset with the `workspace-write` sandbox and `never` approval mode; it must not use `danger-full-access`.

`cordis.patch.yml` disables `modules` and `client-hmr`, loads only the copied system-trust preset root, and mounts `@deepseek-ai/dsh-channel-wecom`. The channel uses one exact user allowlist, an empty chat allowlist, `per-user` group conversation mode, and the `/srv/dsh-workspace` workspace.

The Web server binds only to loopback. `web-runtime` sets `openBrowser: false`, `printUrl: false`, `surfaceContext: false`, and an empty `trustedHosts`, so the unattended service does not write the administration URL token to new startup logs or add the Web UI address to model context.

<a id="credentials-and-model"></a>
## Credentials and model

The credential file contains only `DEEPSEEK_API_KEY`, `WECOM_BOT_SECRET`, and a newly generated high-entropy `WECOM_SESSION_KEY`. This record does not store their values or lengths.

The deployment uses the `deepseek-official` provider and the default `deepseek-v4-flash` model. A real headless request returned `MODEL-OK`, which proves that the model credential and outbound request path work.

`WECOM_SESSION_KEY` defines the WeCom conversation identity mapping. A backup, restore, or migration must preserve this value and the complete `/var/lib/deepseek-harness`; replacing the value creates new mappings and loses continuity with old conversations.

<a id="systemd-service"></a>
## systemd service

`dsh-wecom.service` runs as `dsh:dsh`, uses `/opt/deepseek-harness/current` as its working directory, and starts through `/usr/local/bin/pnpm dsh --profile wecom --port 3180 --no-open`. The unit loads credentials from `/etc/deepseek-harness/wecom.env`.

The service uses `Restart=always`, `RestartSec=10`, `TimeoutStopSec=30`, `UMask=0077`, `PrivateTmp=true`, and `ProtectSystem=strict`. Its `ReadWritePaths` contains only `/var/lib/deepseek-harness` and `/srv/dsh-workspace`.

The service is enabled for `multi-user.target`. At the end of acceptance it is `active/running`, and `NRestarts=1` records the intentional SIGTERM supervision recovery test.

<a id="acceptance-results"></a>
## Acceptance results

The following results come from operations on the deployment host and in the WeCom client.

| Check | Result |
|---|---|
| Locked dependency installation | `pnpm install --frozen-lockfile` succeeded |
| Repository build | `pnpm run build` succeeded |
| Channel tests | All 27 tests in 8 test files passed |
| Channel typecheck | `tsc -p packages/channel/channel-wecom/tsconfig.json --noEmit` exited with status 0 |
| Profile expansion | `pnpm dsh --profile wecom --dump-config` exited with status 0 |
| Model request | Returned `MODEL-OK` |
| Service health | `ActiveState=active` and `SubState=running` |
| HTTP authentication | Unauthenticated `http://127.0.0.1:3180/` returned `401` |
| Listener scope | Port `3180` listens only on `127.0.0.1` |
| WeCom connection | The Node process holds an established connection to `openws.work.weixin.qq.com:443` |
| Authorized direct message | Returned the processing message and then `PROD-PONG` |
| Session continuity | A later request from the same user recovered verification code `7391` |
| Workspace write | `/srv/dsh-workspace/deployment-smoke.txt` contains `wecom-linux-ok` |
| Out-of-workspace write | `/srv/dsh-sandbox-denied.txt` was not created |
| Manual restart recovery | The Session still recovered verification code `7391` after restart |
| Supervision recovery | systemd recovered after SIGTERM, and WeCom returned `SUPERVISOR-OK` |
| Log privacy | The three secrets and accepted acceptance messages were absent from the journal |

<a id="open-items"></a>
## Open items

- `allowedChats` is empty, so no group chat is authorized. After an exact chat ID is available, add it to the list, retain `groupConversationMode: per-user`, validate the configuration, and restart the service.
- The unauthorized-user check requires a second WeCom identity. When a test identity is available, confirm that the channel returns the unauthorized message without starting a model turn.
- The old BotID owner must remain stopped with automatic startup disabled; the channel has no leader election.
- Production backups still need integration with the company's encrypted backup system. A backup must include both `/var/lib/deepseek-harness` and `/etc/deepseek-harness/wecom.env`.

<a id="routine-operations"></a>
## Routine operations

Use systemd to manage the process. Do not start the application directly from a package bin or another Node entry point.

```sh
sudo systemctl status dsh-wecom --no-pager
sudo systemctl restart dsh-wecom
sudo systemctl stop dsh-wecom
sudo journalctl -u dsh-wecom -f
```

Check the service and listener state:

```sh
sudo systemctl show dsh-wecom -p ActiveState -p SubState -p MainPID -p NRestarts
curl -o /dev/null -s -w '%{http_code}\n' http://127.0.0.1:3180/
sudo ss -ltnp | grep ':3180'
sudo ss -tpn | grep ':443'
```

After a profile change, expand the configuration before restarting the service:

```sh
sudo -u dsh -H env PATH=/usr/local/bin:/usr/bin:/bin DSH_HOME=/var/lib/deepseek-harness /bin/bash -c '
  set -euo pipefail
  set -a
  source /etc/deepseek-harness/wecom.env
  set +a
  cd /opt/deepseek-harness/current
  pnpm dsh --profile wecom --dump-config >/dev/null
'
sudo systemctl restart dsh-wecom
```

<a id="upgrade-and-rollback"></a>
## Upgrade and rollback

For an upgrade, install, build, and test in a new `/opt/deepseek-harness/releases/<release-ref>` directory. Stop the service before updating the `current` link, reconcile the profile dependency against the new release, expand the configuration, make a real model request, start the service, and repeat acceptance.

```sh
sudo systemctl stop dsh-wecom
sudo ln -sfn /opt/deepseek-harness/releases/<release-ref> /opt/deepseek-harness/current
cd /opt/deepseek-harness/current
sudo -u dsh -H env PATH=/usr/local/bin:/usr/bin:/bin DSH_HOME=/var/lib/deepseek-harness pnpm dsh plugin --profile wecom install
```

Do not roll back existing data across an incompatible SQLite schema or Session format. When a release changes an on-disk format, restore the `/var/lib/deepseek-harness` backup that matches the target version and the `WECOM_SESSION_KEY` for the same deployment identity.

<a id="security-constraints"></a>
## Security constraints

- Never commit the credential file, BotID, user or chat IDs, administration token, or real message content to Git.
- `allowedUsers` and `allowedChats` must contain exact values and must not use the `"*"` wildcard.
- Port `3180` must remain loopback-only and must not be exposed through a firewall or reverse proxy.
- `wecom-channel` must retain `workspace-write` or narrow to `read-only`, and it must retain `approval: never`.
- The unattended preset must keep `tool-ask-user` disabled.
- Only one process can own a BotID at a time.
- Before sharing journal output, inspect and redact URL tokens, provider identifiers, and other sensitive data.

<a id="further-exploration"></a>
## Further Exploration

- [WeCom Linux deployment guide](wecom-linux-deployment.md) — complete installation, cutover, acceptance, and troubleshooting procedure.
- [WeCom channel reference](../../../packages/channel/channel-wecom/README.md) — configuration fields, persistence semantics, and known limitations.
- [Linux sandbox provider](../../../packages/sandbox/sandbox-local/README.md) — bubblewrap, Landlock, and failure behavior.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Non-authoritative maintenance context</summary>

This page records the deployment acceptance snapshot from `2026-09-01`. A maintainer who changes the release, host, model route, allowlist, directory permissions, or systemd unit must update the corresponding current state and rerun the affected acceptance checks.

</details>
