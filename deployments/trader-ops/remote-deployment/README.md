# Remote deployment record

English | [中文](README.zh.md)

This record describes the validated Trader Ops deployment on the remote Debian host. It records the running release, service wiring, checks performed after the service-account change, and the safe operator path for the next verification. It contains no credential values, WeCom identity values, Session keys, URL tokens, or message content.

## Summary

The remote deployment runs Harness and OpenViking on one Debian host. Harness listens on loopback; a socket proxy exposes the selected private-LAN address. OpenViking stays on its loopback port and Ollama stays on the Docker bridge. The `dsh-trader-ops` systemd service runs as `cfi:cfi` and loads the `web` profile with Trader Ops patches.

The deployed channel checks whether a mapped persistent Session still exists before resuming it. A missing mapped Session starts a fresh Session, so deleting a Session no longer prevents the next WeCom message from creating a new conversation.

## Table of Contents

- [Deployment identity](#deployment-identity)
- [Service and network](#service-and-network)
- [Configuration applied](#configuration-applied)
- [Verification evidence](#verification-evidence)
- [WeCom session recreation](#wecom-session-recreation)
- [Routine operations](#routine-operations)
- [Safety constraints](#safety-constraints)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="deployment-identity"></a>
## Deployment identity

| Item | Recorded value |
|---|---|
| SSH target | `dsh-server` |
| Hostname | `debian` |
| Verification date | `2026-09-24` |
| Release marker | `/opt/deepseek-harness/current/.trader-ops-built` |
| Release entry | `/opt/deepseek-harness/current` |
| Harness service | `dsh-trader-ops.service` |
| Profile | `web` |
| Service account | `cfi:cfi` |

The release marker names the complete source commit used to build the active release. The running service and its OpenViking MCP proxy both use the `cfi` account.

<a id="service-and-network"></a>
## Service and network

| Component | Observed state |
|---|---|
| Harness service | `active/running` |
| Current systemd restart count | `0` |
| Harness loopback response | HTTP `401` without Web authentication |
| Private-LAN entry point | `192.168.4.103:3180` |
| Private-LAN response | HTTP `401` without Web authentication |
| OpenViking health | HTTP `200` |
| OpenViking readiness | HTTP `200` |
| Listener addresses | Harness at `127.0.0.1:3180`; socket proxy at `192.168.4.103:3180` |

The service starts the built CLI through systemd with the `trader-ops` patch files, binds Harness to `127.0.0.1:3180`, and declares the private-LAN authority `192.168.4.103:3180`. The proxy exposes the private address without changing the loopback bind used by Harness.

<a id="configuration-applied"></a>
## Configuration applied

The remote operator completed the runtime configuration and restart after the release was installed.

- The `web` profile loads the base runtime, AIHubMix route, OpenViking memory integration, and WeCom channel patch.
- The WeCom channel keeps exact allowlists and does not use a wildcard entry.
- The channel uses the unattended noninteractive preset with the confined workspace permission preset.
- Harness keeps its Web endpoint on loopback; the private-LAN socket proxy is the only additional entry point.
- Credentials remain in the root-managed environment file on the remote host and are not copied into this repository.

<a id="verification-evidence"></a>
## Verification evidence

The following checks were run against the remote host after configuration:

| Check | Result |
|---|---|
| systemd state | `ActiveState=active`, `SubState=running` |
| systemd supervision | `NRestarts=0` for the current activation |
| Service ownership | Harness and the OpenViking MCP proxy ran as `cfi:cfi`; release, profile, and workspace directories belonged to `cfi:cfi` |
| Harness authentication boundary | Loopback and private-LAN requests returned `401` without credentials |
| OpenViking health and readiness | Both endpoints returned `200` |
| Listener scope | Harness listened on loopback; the socket proxy exposed the selected private-LAN address |
| Profile verification | OpenViking patch, minimal WeCom preset, policy, skills, and knowledge checks passed |

The status checks prove that the service and its dependent endpoints are ready. They do not replace a real WeCom message after deleting a mapped Session; that behavior still needs one operator-side acceptance message.

<a id="wecom-session-recreation"></a>
## WeCom session recreation

Use this acceptance sequence after deleting an existing mapped Session:

1. Send a new direct message from the same allowed WeCom user.
2. Confirm that the bot sends its normal processing response and completes the new turn.
3. Confirm that the new message is associated with a newly created Session rather than the deleted identifier.
4. If the message fails, record only the timestamp and the service status; do not copy credentials, URL tokens, user IDs, chat IDs, or message content into an issue.

The expected result is a successful new turn without manually creating a Session or changing `WECOM_SESSION_KEY`.

<a id="routine-operations"></a>
## Routine operations

Inspect the service and endpoint health from the remote host:

```bash
sudo systemctl show dsh-trader-ops -p ActiveState -p SubState -p MainPID -p NRestarts
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3180/
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.4.103:3180/
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1933/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1933/ready
```

Restart through the reviewed runtime script after a configuration change:

```bash
sudo /opt/deepseek-harness/current/deployments/trader-ops/scripts/restart-runtime.sh
```

Follow the existing [remote deployment runbook](../DEPLOYMENT.md) for release installation, allowlist changes, backup, rollback, and log handling.

<a id="safety-constraints"></a>
## Safety constraints

- Keep `WECOM_SESSION_KEY` unchanged when preserving existing WeCom conversation mappings.
- Never place secrets, identity allowlists, Session keys, authentication tokens, or real message content in Git or shared logs.
- Keep Harness on loopback and expose only the reviewed private-LAN proxy address.
- Keep the WeCom channel noninteractive and confined to the approved workspace.
- Preserve the complete `/var/lib/deepseek-harness` data directory before a release or data migration.
- Stop another process that owns the same BotID before enabling this service; WeCom permits one active long connection per BotID.

<a id="further-exploration"></a>
## Further Exploration

- [Remote deployment runbook](../DEPLOYMENT.md) — installation, configuration, acceptance, upgrade, and rollback.
- [WeCom Linux deployment guide](../../../docs/user/guide/wecom-linux-deployment.md) — channel-specific Linux procedure and acceptance checks.
- [WeCom channel reference](../../../packages/channel/channel-wecom/README.md) — configuration and Session mapping semantics.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Non-authoritative maintenance context</summary>

This README is a deployment snapshot for `2026-09-24`. Update the release marker, endpoint values, service state, and verification table when the remote release or runtime wiring changes.

</details>
