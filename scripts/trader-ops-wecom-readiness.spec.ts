/** Deployment readiness orders channel activation independently of Loader row order. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Skills from '@deepseek-ai/dsh-skill'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import CompactionBasic from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { expect, it, onTestFinished, vi } from 'vitest'
// @ts-expect-error Deployment plugins run as plain ESM.
import * as providerModule from '../deployments/trader-ops/scripts/wecom-preset-provider.mjs'
// @ts-expect-error Deployment scripts run as plain ESM.
import * as rendererModule from '../deployments/trader-ops/scripts/render-wecom-preset.mjs'

const provider = providerModule as Plugin.Object<{ path: string }>
const { inject } = providerModule as { inject: string[] }
const { renderWeComPreset } = rendererModule as {
  renderWeComPreset: (root: string) => Promise<void>
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-readiness-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  await renderWeComPreset(root)
  for (const service of inject) {
    if (service !== 'agentPresets') ctx.provide(service, {})
  }
  ctx.loader.builtins['trader-ops-preset'] = provider
  const start = vi.fn()
  const stop = vi.fn()
  ctx.loader.builtins['trader-ops-channel'] = {
    inject: ['agentPresets'],
    apply(owner: Context) {
      start()
      owner.effect(() => stop)
    },
  }
  const channel = await ctx.loader.create({
    name: 'cordis:trader-ops-channel',
    inject: ['traderOpsWeComPresetReady'],
  })
  return { ctx, root, start, stop, channel }
}

it('waits for preset registration, then stops the channel when registration unloads', async () => {
  const { ctx, root, start, stop, channel } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const unregister = vi.fn()
  const resolve = vi.fn().mockResolvedValue({ id: 'trader-ops-wecom' })
  ctx.provide('agentPresets', {
    async register() {
      entered.resolve(undefined)
      await release.promise
      return unregister
    },
    resolve,
  })
  const preset = await ctx.loader.create({ name: 'cordis:trader-ops-preset', config: { path: join(root, 'preset.cordis.yml') } })
  await entered.promise
  expect(ctx.loader.resolve(channel).fiber!.state).toBe(FiberState.PENDING)
  expect(start).not.toHaveBeenCalled()
  release.resolve(undefined)
  await ctx.loader.await()
  expect(resolve).toHaveBeenCalledWith('trader-ops-wecom')
  expect(start).toHaveBeenCalledTimes(1)
  await ctx.loader.resolve(preset).fiber!.dispose()
  await ctx.loader.await()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(unregister).toHaveBeenCalledTimes(1)
})

it('keeps the channel inactive when the declaration is invalid', async () => {
  const { ctx, root, start, channel } = await fixture()
  const register = vi.fn()
  ctx.provide('agentPresets', { register })
  await writeFile(join(root, 'preset.cordis.yml'), '[]\n')
  const preset = await ctx.loader.create({ name: 'cordis:trader-ops-preset', config: { path: join(root, 'preset.cordis.yml') } })
  await ctx.loader.await()
  expect(ctx.loader.resolve(preset).fiber!.state).toBe(FiberState.FAILED)
  expect(ctx.loader.resolve(channel).fiber!.state).toBe(FiberState.PENDING)
  expect(register).not.toHaveBeenCalled()
  expect(start).not.toHaveBeenCalled()
})

it('releases registration when the registered composition cannot resolve', async () => {
  const { ctx, root, start } = await fixture()
  const unregister = vi.fn()
  ctx.provide('agentPresets', {
    register: vi.fn().mockResolvedValue(unregister),
    resolve: vi.fn().mockRejectedValue(new Error('unusable preset')),
  })
  const preset = await ctx.loader.create({ name: 'cordis:trader-ops-preset', config: { path: join(root, 'preset.cordis.yml') } })
  await ctx.loader.await()
  expect(ctx.loader.resolve(preset).fiber!.state).toBe(FiberState.FAILED)
  expect(start).not.toHaveBeenCalled()
  expect(unregister).toHaveBeenCalledTimes(1)
})

it('registers and resolves the actual reviewed preset through a real Loader and registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-composition-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await renderWeComPreset(root)
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  const modules: Record<string, Plugin> = {
    '@deepseek-ai/dsh-persona': Persona,
    '@deepseek-ai/dsh-tool-skill': ToolSkill,
    '@deepseek-ai/dsh-compaction-basic': CompactionBasic,
    '@deepseek-ai/dsh-compaction-tool-result-pruner': ToolResultPruner,
  }
  // Source-plane module resolution keeps every mounted component in this runtime.
  if (ctx.loader.internal === undefined) throw new Error('Test Loader has no module resolver')
  const imports = vi.spyOn(ctx.loader.internal, 'import').mockImplementation(async (name: string) => {
    const plugin = modules[name]
    if (plugin === undefined) throw new Error(`Unexpected test import: ${name}`)
    return plugin
  })
  onTestFinished(() => { imports.mockRestore() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, Tools, Agents, Skills, TokenMeter]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentPresets, { default: 'trader-ops-wecom' })
  ctx.loader.builtins['trader-ops-preset'] = provider
  const resolved = vi.fn()
  ctx.loader.builtins['trader-ops-reader'] = {
    inject: ['agentPresets'],
    async apply(owner: Context) {
      resolved(await owner.agentPresets.resolve('trader-ops-wecom'))
      await using lease = await owner.agentPresets.acquireScope('trader-ops-wecom')
      expect(lease.key).toBeDefined()
    },
  }
  const reader = await ctx.loader.create({ name: 'cordis:trader-ops-reader', inject: ['traderOpsWeComPresetReady'] })
  await ctx.loader.create({ name: 'cordis:trader-ops-preset', config: { path: join(root, 'preset.cordis.yml') } })
  await ctx.loader.await()
  expect(ctx.loader.resolve(reader).fiber!.state).toBe(FiberState.ACTIVE)
  expect(resolved).toHaveBeenCalledOnce()
})
