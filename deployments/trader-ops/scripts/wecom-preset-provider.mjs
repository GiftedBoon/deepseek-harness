/** Deployment-owned registration and readiness for the reviewed WeCom preset. */
import { readWeComPreset } from './render-wecom-preset.mjs'

// These Host services satisfy every row of the reviewed preset before a
// channel can audit it during its own activation.
export const inject = ['agentPresets', 'agents', 'tools', 'skills', 'systemPrompt', 'llm', 'tokenMeter', 'sessions']

/**
 * Register the reviewed preset and publish readiness for the WeCom channel.
 * @param {object} ctx Cordis context owning registration and readiness.
 * @param {{path: string}} config Generated preset declaration path.
 * @returns {AsyncGenerator<Function>} Registration cleanup owned by Cordis.
 */
export async function* apply(ctx, config) {
  if (typeof config?.path !== 'string' || config.path.length === 0) {
    throw new Error('Trader Ops WeCom preset requires a declaration path')
  }
  const definition = await readWeComPreset(config.path)
  yield await ctx.agentPresets.register(definition)
  await ctx.agentPresets.resolve(definition.id)
  ctx.provide('traderOpsWeComPresetReady', { id: definition.id })
}
