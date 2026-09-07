/**
 * Fail-closed deployment policy for Trader Ops tool calls. The extensible
 * pre-execute gate owns allow/ask/deny, while a monotonic guard prevents an
 * earlier short-circuiting listener from bypassing this plugin.
 * @module @deepseek-ai/dsh-experimental-quant-tool-policy
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import * as yaml from 'js-yaml'

export const name = 'quant-tool-policy'
export const inject = ['tools']

/** Deployment environment used to select eligible policy rules. */
export type PolicyEnvironment = 'development' | 'staging' | 'production'

/** Action one matching policy rule assigns to a tool call. */
export type PolicyDecision = 'allow' | 'require_approval' | 'deny'

/** Required plugin configuration; neither path nor environment is inferred. */
export interface Config {
  /** YAML policy document, resolved from the process working directory. */
  policyFile: string
  /** Explicit deployment environment; policy selection never guesses it. */
  environment: PolicyEnvironment
}

export const Config: z<Config> = z.object({
  policyFile: z.string().required(),
  environment: z.union(['development', 'staging', 'production'] as const).required(),
})

/** Validated version-1 rule with one exact or wildcard tool selector. */
export interface ToolPolicyRule {
  id: string
  tools?: string[]
  toolPattern?: string
  risk: string
  environments: PolicyEnvironment[]
  decision: PolicyDecision
}

/** Strict, fail-closed version-1 policy document consumed at plugin load. */
export interface ToolPolicyDocument {
  version: 1
  status: 'experimental' | 'active'
  enforced: true
  default: 'deny'
  rules: ToolPolicyRule[]
}

/** Effective decision and audit labels chosen for one tool and environment. */
export interface ResolvedToolPolicy {
  decision: PolicyDecision
  risk: string
  ruleId: string
}

const ENVIRONMENTS = new Set<PolicyEnvironment>(['development', 'staging', 'production'])
const DECISIONS = new Set<PolicyDecision>(['allow', 'require_approval', 'deny'])
const PATTERN_CHARACTERS = /^[A-Za-z0-9_.:*\-]+$/

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`quant-tool-policy: ${label} contains unknown field${unknown.length === 1 ? '' : 's'} ${unknown.map(key => `"${key}"`).join(', ')}`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`quant-tool-policy: ${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`quant-tool-policy: ${label} must be a non-empty string`)
  }
  return value
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`quant-tool-policy: ${label} must be a non-empty list`)
  }
  const values = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`))
  if (new Set(values).size !== values.length) {
    throw new Error(`quant-tool-policy: ${label} must not contain duplicates`)
  }
  return values
}

/**
 * Parse and strictly validate the version-1 deployment policy contract.
 * @param value - untrusted value produced by the YAML parser.
 * @returns a normalized, fail-closed policy document.
 */
export function parsePolicyDocument(value: unknown): ToolPolicyDocument {
  const document = record(value, 'policy document')
  allowedKeys(document, ['version', 'status', 'enforced', 'default', 'rules'], 'policy document')
  if (document.version !== 1) throw new Error('quant-tool-policy: policy version must be 1')
  if (document.status !== 'experimental' && document.status !== 'active') {
    throw new Error('quant-tool-policy: policy status must be experimental or active')
  }
  if (document.enforced !== true) {
    throw new Error('quant-tool-policy: policy must declare enforced: true')
  }
  if (document.default !== 'deny') {
    throw new Error('quant-tool-policy: policy default must be deny')
  }
  if (!Array.isArray(document.rules)) throw new Error('quant-tool-policy: rules must be a list')

  const ids = new Set<string>()
  const rules = document.rules.map((candidate, index): ToolPolicyRule => {
    const source = record(candidate, `rules[${index}]`)
    allowedKeys(source, ['id', 'tools', 'tool_pattern', 'risk', 'environments', 'decision'], `rules[${index}]`)
    const id = nonEmptyString(source.id, `rules[${index}].id`)
    if (ids.has(id)) throw new Error(`quant-tool-policy: duplicate rule id "${id}"`)
    ids.add(id)

    const hasTools = source.tools !== undefined
    const hasPattern = source.tool_pattern !== undefined
    if (hasTools === hasPattern) {
      throw new Error(`quant-tool-policy: rule "${id}" must declare exactly one of tools or tool_pattern`)
    }
    const tools = hasTools ? stringList(source.tools, `rule "${id}" tools`) : undefined
    if (tools?.some(tool => tool.includes('*'))) {
      throw new Error(`quant-tool-policy: rule "${id}" tools entries must be exact names`)
    }
    const toolPattern = hasPattern
      ? nonEmptyString(source.tool_pattern, `rule "${id}" tool_pattern`)
      : undefined
    if (toolPattern !== undefined && !PATTERN_CHARACTERS.test(toolPattern)) {
      throw new Error(`quant-tool-policy: rule "${id}" tool_pattern contains unsupported characters`)
    }

    const risk = nonEmptyString(source.risk, `rule "${id}" risk`)
    const environments = stringList(source.environments, `rule "${id}" environments`)
    if (!environments.every(environment => ENVIRONMENTS.has(environment as PolicyEnvironment))) {
      throw new Error(`quant-tool-policy: rule "${id}" contains an unsupported environment`)
    }
    const decision = nonEmptyString(source.decision, `rule "${id}" decision`)
    if (!DECISIONS.has(decision as PolicyDecision)) {
      throw new Error(`quant-tool-policy: rule "${id}" contains an unsupported decision`)
    }
    return {
      id,
      ...(tools === undefined ? {} : { tools }),
      ...(toolPattern === undefined ? {} : { toolPattern }),
      risk,
      environments: environments as PolicyEnvironment[],
      decision: decision as PolicyDecision,
    }
  })

  return {
    version: 1,
    status: document.status,
    enforced: true,
    default: 'deny',
    rules,
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Resolve the first environment-matching rule; unmatched tools are denied.
 * @param policy - validated policy snapshot.
 * @param environment - explicit active deployment environment.
 * @param toolName - exact registered tool name being called.
 * @returns the selected decision, risk label, and rule identifier.
 */
export function resolveToolPolicy(
  policy: ToolPolicyDocument,
  environment: PolicyEnvironment,
  toolName: string,
): ResolvedToolPolicy {
  for (const rule of policy.rules) {
    if (!rule.environments.includes(environment)) continue
    const matches = rule.tools?.includes(toolName)
      ?? (rule.toolPattern === undefined ? false : wildcardToRegExp(rule.toolPattern).test(toolName))
    if (matches) return { decision: rule.decision, risk: rule.risk, ruleId: rule.id }
  }
  return { decision: 'deny', risk: 'unclassified', ruleId: 'default-deny' }
}

function reasonFor(
  resolved: ResolvedToolPolicy,
  environment: PolicyEnvironment,
  toolName: string,
): string {
  if (resolved.decision === 'require_approval') {
    return `Trader Ops policy "${resolved.ruleId}" requires ${resolved.risk} approval for tool "${toolName}" in ${environment}.`
  }
  return `Tool "${toolName}" is denied by Trader Ops policy "${resolved.ruleId}" in ${environment}.`
}

/** Load one immutable policy snapshot and install both execution barriers. */
export function apply(ctx: Context, config: Config): void {
  const policyPath = resolve(config.policyFile)
  let raw: unknown
  try {
    raw = yaml.load(readFileSync(policyPath, 'utf8'))
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`quant-tool-policy: cannot load ${policyPath}: ${detail}`)
  }
  const policy = parsePolicyDocument(raw)
  const traversed = new WeakSet<ToolExecution>()

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const resolved = resolveToolPolicy(policy, config.environment, exec.name)
    traversed.add(exec)
    if (resolved.decision === 'allow') return next()
    if (resolved.decision === 'require_approval') {
      return { kind: 'ask', reason: reasonFor(resolved, config.environment, exec.name) }
    }
    return { kind: 'deny', reason: reasonFor(resolved, config.environment, exec.name) }
  }, { prepend: true })

  ctx.tools.guard((exec) => {
    const resolved = resolveToolPolicy(policy, config.environment, exec.name)
    if (!traversed.has(exec)) {
      return `Tool "${exec.name}" did not traverse Trader Ops pre-execute policy.`
    }
    if (resolved.decision === 'deny') return reasonFor(resolved, config.environment, exec.name)
    return undefined
  })
}
