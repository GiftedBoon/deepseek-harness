# Local development

English | [中文](DEVELOPMENT.zh.md)

## 1. Prepare the environment

Use Node.js 22.19 or later in the 22.x line, or Node.js 24 or later, together with pnpm, Docker, and Docker Compose. Install repository dependencies from the repository root:

```bash
pnpm install
```

On an Apple Silicon development Mac, install the current Docker Desktop for Apple silicon, open `/Applications/Docker.app`, and complete its first-run privileged setup. Keep the user-level CLI directory on `PATH` (`$HOME/.docker/bin`), then verify both the daemon and ARM64 container path:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Do not disable Gatekeeper or remove Docker's quarantine metadata. If Docker Desktop requests administrator authorization for privileged networking or `/usr/local/bin` links, complete that prompt interactively; repository scripts must not automate a password or license acceptance.

Copy the template to an untracked local environment file and change the persistent directories to paths writable by the current user:

```bash
cp deployments/trader-ops/.env.example deployments/trader-ops/.env
chmod 600 deployments/trader-ops/.env
```

Replace at least `OPENVIKING_HOME`, `DSH_HOME`, and `OPENVIKING_API_KEY`. Load the variables:

```bash
set -a
source deployments/trader-ops/.env
set +a
```

## 2. Initialize and start OpenViking

After the container starts for the first time, the official entrypoint waits for configuration. In another terminal, run the initialization wizard and configure an available VLM, embedding model, and `server.root_api_key`:

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml up -d

docker exec -it trader-ops-openviking openviking-server init
```

Model providers, model names, and credentials depend on the deployment, so the repository template cannot invent them. Restart the container and check the service after initialization:

```bash
docker restart trader-ops-openviking
curl --fail http://127.0.0.1:1933/health
curl --fail http://127.0.0.1:1933/ready
```

The local debugging interface is available at `http://127.0.0.1:1933/studio`.

## 3. Install the DSH plugin and validate the Profile

The bootstrap script installs `@openviking/dsh-memory-plugin@0.3.0` into the `web` Profile, then verifies that the effective configuration contains OpenViking, the Trader Ops tool policy, and the skill provider:

```bash
deployments/trader-ops/scripts/bootstrap-profile.sh
deployments/trader-ops/scripts/verify-deployment.sh
```

This plugin version requires the related DSH 0.1.x packages to be at least `0.1.0-rc.6` and below `0.2.0`; this repository's `0.1.3-alpha.1` version is in that range. Recheck the peer dependency range and rerun configuration composition whenever Harness or the plugin changes.

The isolated Profile install currently reports those three DSH packages as missing peer dependencies because the DSH host supplies them rather than the Profile package. The observed install is acceptable only when the host versions satisfy the range and `--dump-config` succeeds; investigate any additional peer warning.

## 4. Start Harness

```bash
pnpm dsh web \
  --patch deployments/trader-ops/config/dsh/trader-ops.patch.yml
```

The service must still start when there is no business knowledge and no `SKILL.md`: the Trader Ops skill count is zero and OpenViking provides an empty recall/memory baseline. This is the expected state.

## 5. Add content later

- Add reviewed Markdown to `knowledge/business`, `knowledge/systems`, or `knowledge/runbooks`, then submit it through an explicit OpenViking ingestion path. Exclude `README.md` and `README.zh.md` from ingestion.
- Add a complete `SKILL.md` under a direct `skills/<name>/` child. The Loader recognizes direct children as skill bundles; do not add another business-category layer.
- After a business MCP server exists, copy and review `config/dsh/trader-ops-mcp.patch.yml.example`, remove `.example`, and load it as a second `--patch` argument.
- Update `policies/tool-access.yaml` when tools are added. The Harness-side plugin enforces it with first-match rules and default deny; `risk-levels.yaml` and `approvals.yaml` remain design contracts until trusted identity and approval stores exist.

## 6. Stop the local service

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml down
```

This command does not delete persistent data under `OPENVIKING_HOME`.
