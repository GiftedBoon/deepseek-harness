/** Unit and real Loader-path coverage for the fail-closed tool policy. */

import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as policyPlugin from '@deepseek-ai/dsh-experimental-quant-tool-policy'
import { parsePolicyDocument, resolveToolPolicy } from '@deepseek-ai/dsh-experimental-quant-tool-policy'

const policyFile = fileURLToPath(new URL('./fixtures/policy.yaml', import.meta.url))
const signal = new AbortController().signal

function call(name: string, id = name): ToolExecutionInput {
  return { callId: ToolCallId(id), name, arguments: {}, signal }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const name of ['safe_read', 'controlled_write', 'destroy', 'unknown']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: name,
      parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'executed' }] },
    }))
  }
  await ctx.plugin(policyPlugin, { policyFile, environment: 'development' })
  return ctx
}

describe('policy document validation and resolution', () => {
  it('uses first-match semantics and defaults to deny', () => {
    const policy = parsePolicyDocument({
      version: 1,
      status: 'experimental',
      enforced: true,
      default: 'deny',
      rules: [{
        id: 'reads',
        tool_pattern: 'mcp__source__get_*',
        risk: 'read_only',
        environments: ['development'],
        decision: 'allow',
      }],
    })
    expect(resolveToolPolicy(policy, 'development', 'mcp__source__get_state')).toMatchObject({
      decision: 'allow', ruleId: 'reads',
    })
    expect(resolveToolPolicy(policy, 'production', 'mcp__source__get_state')).toMatchObject({
      decision: 'deny', ruleId: 'default-deny',
    })
  })

  it('rejects a document that is not explicitly enforced and default-deny', () => {
    expect(() => parsePolicyDocument({ version: 1, status: 'experimental', enforced: false, default: 'allow', rules: [] }))
      .toThrow(/enforced: true/)
  })

  it('rejects ambiguous exact-and-pattern rules', () => {
    expect(() => parsePolicyDocument({
      version: 1,
      status: 'experimental',
      enforced: true,
      default: 'deny',
      rules: [{
        id: 'ambiguous', tools: ['a'], tool_pattern: '*', risk: 'read_only',
        environments: ['development'], decision: 'allow',
      }],
    })).toThrow(/exactly one/)
  })

  it('rejects unknown fields instead of silently accepting policy typos', () => {
    expect(() => parsePolicyDocument({
      version: 1, status: 'experimental', enforced: true, default: 'deny', rules: [],
      defualt: 'allow',
    })).toThrow(/unknown field "defualt"/)
  })
})

describe('policy execution barriers', () => {
  it('allows an explicitly permitted tool', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute(call('safe_read'))
    expect(result.isError).toBe(false)
  })

  it('denies explicit and default-deny tools before dispatch', async () => {
    const ctx = await setup()
    await expect(ctx.tools.execute(call('destroy'))).resolves.toMatchObject({ isError: true })
    await expect(ctx.tools.execute(call('unknown'))).resolves.toMatchObject({ isError: true })
  })

  it('fails closed when approval is required but no approval service is loaded', async () => {
    const ctx = await setup()
    const result = await ctx.tools.execute(call('controlled_write'))
    expect(result.isError).toBe(true)
  })

  it('uses the monotonic guard if another listener short-circuits the waterfall', async () => {
    const ctx = await setup()
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
    const result = await ctx.tools.execute(call('destroy', 'bypass-attempt'))
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toMatch(/did not traverse Trader Ops/)
  })
})

describe('real Loader path', () => {
  it('keeps the function-plugin exports through Loader.unwrapExports', () => {
    expect('default' in policyPlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(policyPlugin) as Record<string, unknown>
    expect(unwrapped.name).toBe('quant-tool-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots the unwrapped plugin over the real tool runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(defineContentToolFixture({
      name: 'safe_read', description: 'safe', parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(policyPlugin) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { policyFile, environment: 'development' })
    await expect(ctx.tools.execute(call('safe_read'))).resolves.toMatchObject({ isError: false })
    await fiber.dispose()
  })
})
