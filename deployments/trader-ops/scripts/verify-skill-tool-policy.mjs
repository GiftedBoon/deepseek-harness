#!/usr/bin/env node
/**
 * Resolve every tool named by the Trader Ops skills and the WeCom scheduled
 * actions against `policies/tool-access.yaml`.
 *
 * Each referenced tool must resolve to `allow` in every environment. The WeCom
 * permission preset is `approval: never`, so a `require_approval` decision
 * rejects there, and an unclassified tool falls through to the policy's
 * `default: deny` while the Skill still instructs the model to call it.
 *
 * Usage: node verify-skill-tool-policy.mjs <repoRoot> <deploymentRoot>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENVIRONMENTS = ['development', 'staging', 'production']
/** `mcp__<serverName>__<tool>`; the trailing wildcard in prose does not match. */
const TOOL_REFERENCE = /mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_]+/g

const [repoRoot, deploymentRoot] = process.argv.slice(2)
if (repoRoot === undefined || deploymentRoot === undefined) {
  console.error('usage: verify-skill-tool-policy.mjs <repoRoot> <deploymentRoot>')
  process.exit(2)
}

// Resolve both the parser and `js-yaml` through the policy plugin so this gate
// loads exactly the implementation and dependencies the deployment runtime does.
const policyEntry = join(repoRoot, 'packages/experimental/quant-tool-policy/lib/index.js')
const policyModule = await import(pathToFileURL(policyEntry).href)
const loadYaml = createRequire(policyEntry)('js-yaml').load
const policy = policyModule.parsePolicyDocument(
  loadYaml(readFileSync(join(deploymentRoot, 'policies/tool-access.yaml'), 'utf8')),
)

const names = new Set()
for (const file of referenceFiles(deploymentRoot)) {
  for (const match of readFileSync(file, 'utf8').matchAll(TOOL_REFERENCE)) names.add(match[0])
}
if (names.size === 0) {
  console.error('verify-skill-tool-policy: found no referenced tool names; check the skill root and patch paths.')
  process.exit(1)
}

const violations = []
for (const name of [...names].sort()) {
  for (const environment of ENVIRONMENTS) {
    const resolved = policyModule.resolveToolPolicy(policy, environment, name)
    if (resolved.decision !== 'allow') {
      violations.push(`${name} [${environment}] -> ${resolved.decision} (${resolved.ruleId})`)
    }
  }
}
if (violations.length > 0) {
  console.error('verify-skill-tool-policy: every referenced tool must resolve to allow in every environment:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`verify-skill-tool-policy: ${names.size} referenced tool(s) resolve to allow in every deployment environment.`)

/** Skill bodies plus the scheduled-action definitions that name a tool. */
function referenceFiles(root) {
  const files = []
  const skillsRoot = join(root, 'skills')
  for (const entry of readdirSync(skillsRoot)) {
    const directory = join(skillsRoot, entry)
    if (!statSync(directory).isDirectory()) continue
    const skillFile = join(directory, 'SKILL.md')
    if (isFile(skillFile)) files.push(skillFile)
  }
  files.push(join(root, 'config/dsh/trader-ops-wecom.patch.yml'))
  return files
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
