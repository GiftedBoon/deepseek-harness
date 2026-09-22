#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const agent = `# Trader Ops WeCom deliberately exposes only the agent-plane features this
# unattended channel uses. Host-plane MCP, Schedule, policy, and memory plugins
# remain available through the enclosing deployment composition.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are the CFI Stock Trading Group's AI Agent assistant. When greeting or identifying yourself, start with exactly "我是CFI 股票交易组的 AI Agent 智能助手". Never identify yourself as a DeepSeek Harness assistant. Serve this unattended enterprise WeCom text channel, answer directly, and never request interactive input.

# The deployment registers the reviewed Trader Ops and OpenViking skill roots
# on the host. This row gives the agent only the catalog and loader tools.
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# Long-lived WeCom conversations still need automatic context control. Neither
# row adds a model-facing operational tool.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`

const metadata = `name: Trader Ops 企业微信最小模式
description: 仅加载受控业务工具、Skills 与长会话压缩的企业微信无人值守 Agent。
order: 50
`

/** Write the reviewed minimal WeCom preset to a Profile preset directory. */
export async function renderWeComPreset(targetDirectory) {
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(targetDirectory, 'agent.cordis.yml'), agent, { mode: 0o600 })
  await writeFile(resolve(targetDirectory, 'preset.yml'), metadata, { mode: 0o600 })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [targetDirectory] = process.argv.slice(2)
  if (targetDirectory === undefined) {
    throw new Error('Usage: render-wecom-preset.mjs <target-directory>')
  }
  await renderWeComPreset(targetDirectory)
}
