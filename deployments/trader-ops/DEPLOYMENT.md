# Remote deployment

English | [中文](DEPLOYMENT.zh.md)

This procedure assumes that Harness and OpenViking run on one controlled Linux host behind an existing reverse proxy. If they run on separate hosts, keep the same secret-management and private-network boundaries and point `OPENVIKING_URL` at a TLS-protected internal address.

## Directory convention

```text
/opt/deepseek-harness/releases/<git-ref>/  # immutable release directory
/opt/deepseek-harness/current              # symlink to the active release
/etc/deepseek-harness/trader-ops.env       # mode 0600, secrets and environment differences
/var/lib/deepseek-harness/                 # DSH Profile and runtime state
/var/lib/openviking/                       # ov.conf, vector data, and runtime data
/srv/dsh-workspace/                        # workspace accessible to the agent
```

Create a dedicated `dsh` user and group and grant them access only to the runtime directories above. The deployment system writes release directories; the runtime user reads them.

## First deployment

1. Extract a reviewed Git revision into a new release directory, run `pnpm install --frozen-lockfile` and the project's build command there, then atomically update the `current` symlink.
2. Create `/etc/deepseek-harness/trader-ops.env` from `.env.example` and set mode `0600`. Replace every placeholder, including the model endpoint and root key; pin `OPENVIKING_IMAGE` to a validated tag or digest in production. Leave `OPENVIKING_API_KEY` empty until the tenant user is created.
3. Start OpenViking with the deployment environment file:

   ```bash
   docker compose --env-file /etc/deepseek-harness/trader-ops.env \
     -f /opt/deepseek-harness/current/deployments/trader-ops/config/openviking/docker-compose.yml up -d
   docker exec -it trader-ops-openviking openviking-server init
   docker restart trader-ops-openviking
   ```

4. Configure the real VLM and embedding model in the initialization wizard. Set `server.root_api_key` from `OPENVIKING_ROOT_API_KEY`, then create the deployment account and user with the root CLI configuration. Store the returned tenant user key as `OPENVIKING_API_KEY`; Harness must not use the root key.
5. Activate a user CLI configuration, run `ov doctor`, load the environment file, and install the pinned DSH plugin:

   ```bash
   set -a
   source /etc/deepseek-harness/trader-ops.env
   set +a
   /opt/deepseek-harness/current/deployments/trader-ops/scripts/bootstrap-profile.sh
   /opt/deepseek-harness/current/deployments/trader-ops/scripts/verify-deployment.sh
   ```

6. Install `config/systemd/dsh-trader-ops.service` at `/etc/systemd/system/`. Verify the `pnpm` path, user, working directory, and `ReadWritePaths` against the real host, then enable the service.
7. Expose Harness only through the reverse proxy; the OpenViking Compose file binds to loopback. Configure TLS, authentication, access logs, request size limits, and timeouts.

## Each release

1. Build a new immutable release without overwriting the running directory.
2. Run `bootstrap-profile.sh` and `--dump-config` against a temporary `DSH_HOME` to confirm that plugin dependencies and patches still compose.
3. Back up `/var/lib/openviking` and `/var/lib/deepseek-harness` before applying required data migrations.
4. Update the `current` link, rerun the bootstrap script with the production `DSH_HOME`, then restart the systemd service.
5. Run `verify-deployment.sh`, followed by read-only recall and empty skill catalog smoke tests.
6. On failure, point `current` back to the previous validated release and restore the matching data backup; do not delete persistent directories in place.

## Pre-production gates

- OpenViking `/health` and `/ready` succeed, and data survives a container restart.
- `dsh --dump-config` contains exactly one expected `openviking-memory-runtime` and includes `trader-ops-tool-policy` plus `trader-ops-skills`.
- The real environment contains no template credentials, and secrets do not appear in Git, logs, or process arguments.
- The reverse proxy, host firewall, and service listen addresses have been reviewed.
- `tool-access.yaml` loads with `enforced: true`, an explicit `TRADER_OPS_ENVIRONMENT`, and default deny. Keep access limited to trusted developers until the business MCP server repeats actor-, resource-, and argument-level authorization.
- Before enabling Trader Ops MCP, review each tool schema, identity propagation path, timeout, retry, idempotency rule, and audit record.

## Backup and monitoring

Backups cover at least `/var/lib/openviking`, `/var/lib/deepseek-harness`, and external approval/audit stores. Monitoring covers OpenViking health/readiness, the Harness process, plugin connection failures, recall latency, MCP tool failure rate, and disk capacity. Automated recovery must never replay non-idempotent business writes.
