import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error Deployment automation intentionally runs as executable plain ESM.
import * as patcher from '../deployments/trader-ops/scripts/patch-openviking-recall-once.mjs'
// @ts-expect-error Deployment automation intentionally runs as executable plain ESM.
import * as renderer from '../deployments/trader-ops/scripts/render-wecom-preset.mjs'

const { patchOpenVikingRecallOnce } = patcher as {
  patchOpenVikingRecallOnce: (packageDirectory: string) => Promise<boolean>
}
const { renderWeComPreset } = renderer as {
  renderWeComPreset: (targetDirectory: string) => Promise<void>
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Trader Ops runtime configuration', () => {
  it('renders only the reviewed WeCom agent-plane rows', async () => {
    const root = await temporaryRoot()
    await renderWeComPreset(root)

    const source = await readFile(join(root, 'agent.cordis.yml'), 'utf8')
    expect(() => load(source)).not.toThrow()
    const ids = [...source.matchAll(/^\s*- id: (.+)$/gm)].map(match => match[1])

    expect(ids).toEqual([
      'persona',
      'tool-skill',
      'compaction',
      'compaction-basic',
      'tool-result-pruner',
    ])
    expect(source).toContain('我是CFI 股票交易组的 AI Agent 智能助手')
    expect(source).not.toMatch(/tool-(?:ask-user|bash|fs|web|subagent|workflow)/)
  })

  it('patches pinned OpenViking recall once and is idempotent', async () => {
    const root = await openVikingFixture('0.3.0')

    await expect(patchOpenVikingRecallOnce(root)).resolves.toBe(true)
    await expect(patchOpenVikingRecallOnce(root)).resolves.toBe(false)

    const source = await readFile(join(root, 'index.mjs'), 'utf8')
    expect(source).toContain('async ({ agent, messages, signal, step }, next)')
    expect(source).toContain('if (step !== 1) return decision;')
  })

  it('rejects an unreviewed OpenViking version or source layout', async () => {
    const wrongVersion = await openVikingFixture('0.4.0')
    await expect(patchOpenVikingRecallOnce(wrongVersion)).rejects.toThrow(
      'supports 0.3.0, got 0.4.0',
    )

    const drifted = await openVikingFixture('0.3.0')
    await writeFile(join(drifted, 'index.mjs'), 'export function apply() {}\n')
    await expect(patchOpenVikingRecallOnce(drifted)).rejects.toThrow(
      'pre-step handler no longer matches',
    )
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trader-ops-runtime-'))
  temporaryDirectories.push(root)
  return root
}

async function openVikingFixture(version: string): Promise<string> {
  const root = await temporaryRoot()
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }))
  await writeFile(join(root, 'index.mjs'), `export function apply(ctx) {
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind !== "enter" || signal.aborted) return decision;
    return { agent, messages };
  });
}
`)
  return root
}
