# Local development

English | [中文](DEVELOPMENT.zh.md)

## 1. Prepare the environment

Use Node.js 22.19 or later in the 22.x line, or Node.js 24 or later, together with pnpm, Docker, Docker Compose, Homebrew, and Ollama. Install repository dependencies from the repository root:

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

Replace the two persistent directories with absolute host paths and replace `OPENVIKING_ROOT_API_KEY` with a random secret. Set `TRADER_OPS_LLM_PROVIDER` to `aihubmix` for the remote OpenAI-compatible route, and keep real provider keys only in this file. Keep `OPENVIKING_API_KEY` empty until OpenViking creates the tenant user. Load the variables:

```bash
set -a
source deployments/trader-ops/.env
set +a
```

## 2. Start local inference and OpenViking

Run Ollama on the macOS host so inference uses Apple Metal. Keep its default loopback listener; Docker Desktop resolves `host.docker.internal` from the OpenViking container:

```bash
brew install ollama
brew services start ollama
ollama pull qwen3-embedding:0.6b
ollama pull guoxuter/ov_intent_analysis_sft:v7_q8
curl --fail http://127.0.0.1:11434/api/tags
```

Install the reviewed local configuration into the persistent OpenViking directory, then start the container:

```bash
install -d "$OPENVIKING_HOME"
install -m 600 deployments/trader-ops/config/openviking/ov.conf.local-macos.example \
  "$OPENVIKING_HOME/ov.conf"
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml up -d
```

The root key is only for account administration. Create a root CLI configuration and a tenant admin, copy the returned user key into `OPENVIKING_API_KEY` in the mode-`0600` `.env`, then reload the environment and activate a user CLI configuration:

```bash
docker exec trader-ops-openviking ov language en
docker exec trader-ops-openviking ov config add custom \
  --name trader-ops-root --url http://127.0.0.1:1933 \
  --root-api-key-env OPENVIKING_ROOT_API_KEY \
  --account trader-ops --user local-dev --activate --force
docker exec trader-ops-openviking ov admin create-account trader-ops \
  --admin local-dev --sudo

set -a
source deployments/trader-ops/.env
set +a
printf '%s' "$OPENVIKING_API_KEY" | docker exec -i trader-ops-openviking \
  ov config add custom --name trader-ops-local \
  --url http://127.0.0.1:1933 --api-key-stdin \
  --account trader-ops --user local-dev --activate --force
```

Check the model, authentication, storage, and HTTP paths together:

```bash
docker exec trader-ops-openviking ov doctor
curl --fail http://127.0.0.1:1933/health
curl --fail http://127.0.0.1:1933/ready
```

The local debugging interface is available at `http://127.0.0.1:1933/studio`. Do not give Harness the root key. Rotate a key immediately if it appears in a terminal capture or log.

## 3. Install the DSH plugin and validate the Profile

The bootstrap script installs `@openviking/dsh-memory-plugin@0.3.0` into the `web` Profile, then verifies that the effective configuration contains OpenViking, the Trader Ops tool policy, and the skill provider:

```bash
deployments/trader-ops/scripts/bootstrap-profile.sh
deployments/trader-ops/scripts/verify-deployment.sh
```

This plugin version requires the related DSH 0.1.x packages to be at least `0.1.0-rc.6` and below `0.2.0`; this repository's `0.1.3-alpha.1` version is in that range. Recheck the peer dependency range and rerun configuration composition whenever Harness or the plugin changes.

The isolated Profile install currently reports those three DSH packages as missing peer dependencies because the DSH host supplies them rather than the Profile package. The observed install is acceptable only when the host versions satisfy the range and `--dump-config` succeeds; investigate any additional peer warning.

Build the source checkout before starting the Web application:

```bash
pnpm run build
```

If `fs-ext` reports a missing native binary and Apple Command Line Tools cannot find the C++ `<memory>` header, rebuild only that dependency with the SDK include directory:

```bash
CPLUS_INCLUDE_PATH=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1 \
  pnpm --filter @deepseek-ai/dsh-session-persistence-jsonl rebuild fs-ext
```

## 4. Start Harness

```bash
pnpm dsh web \
  --patch deployments/trader-ops/config/dsh/trader-ops.patch.yml \
  --patch deployments/trader-ops/config/dsh/trader-ops-aihubmix.patch.yml \
  --patch deployments/trader-ops/config/dsh/trader-ops-wecom.patch.yml \
  --patch deployments/trader-ops/config/dsh/trader-ops-bssh-ops-mcp.patch.yml \
  --no-open
```

The second patch declares the configured AIHubMix endpoint through the supported `llm-pi-ai` OpenAI-compatible route. It reads the endpoint, credential, model id, context window, and output limit from the environment. OpenViking uses the same remote route for semantic extraction while retaining local Ollama models for embedding and query planning. The third patch keeps enterprise WeCom disabled unless `TRADER_OPS_WECOM_ENABLED=1`; use the remote deployment configurator rather than storing real bot credentials in the repository.

The command prints a local access URL and token. The service must still start when there is no business knowledge and no `SKILL.md`: the Trader Ops skill count is zero and OpenViking provides an empty recall/memory baseline. This is the expected state. AIHubMix receives all model-visible prompts, recalled memory, tool descriptions, and user input, so do not send restricted business data until the relay and selected model have passed the required security review.

## 5. Add content later

- Add reviewed, non-empty Markdown to `knowledge/business`, `knowledge/systems`, or `knowledge/runbooks`, then submit it through an explicit OpenViking ingestion path. Exclude `README.md`, `README.zh.md`, and empty or whitespace-only files from ingestion; OpenViking can otherwise derive misleading semantic metadata from the filename alone.
- Add a complete `SKILL.md` under a direct `skills/<name>/` child. The Loader recognizes direct children as skill bundles; do not add another business-category layer.
- The bssh_ops MCP layer is already wired through `config/dsh/trader-ops-bssh-ops-mcp.patch.yml`; enable it with `sudo bash scripts/configure-bssh-ops-mcp.sh --enable`, which prompts for the key without putting it in shell history. Keep the patch loaded in every profile command so its `disabled` flag is controlled by the environment.
- Update `policies/tool-access.yaml` when tools are added. The Harness-side plugin enforces it with first-match rules and default deny; `risk-levels.yaml` and `approvals.yaml` remain design contracts until trusted identity and approval stores exist.

## 6. Stop the local service

```bash
docker compose --env-file deployments/trader-ops/.env \
  -f deployments/trader-ops/config/openviking/docker-compose.yml down
```

This command does not delete persistent data under `OPENVIKING_HOME`.
