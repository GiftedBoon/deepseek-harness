import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const renderScript = resolve(dirname(fileURLToPath(import.meta.url)), '../deployments/trader-ops/scripts/render-wecom-preset.mjs')

test('renders the minimal WeCom preset when launched through a release symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-wecom-'))
  try {
    const current = join(root, 'current')
    const preset = join(root, 'preset')
    await symlink(dirname(renderScript), current, 'junction')

    await execFileAsync(process.execPath, [join(current, 'render-wecom-preset.mjs'), preset])

    const source = await readFile(join(preset, 'agent.cordis.yml'), 'utf8')
    expect([...source.matchAll(/^ *- id: (.+)$/gm)].map(match => match[1])).toEqual([
      'persona', 'tool-skill', 'compaction', 'compaction-basic', 'tool-result-pruner',
    ])
    expect(source).toContain('我是CFI 股票交易组的 AI Agent 智能助手')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
