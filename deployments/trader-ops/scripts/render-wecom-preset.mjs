#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [sourceDirectory, targetDirectory] = process.argv.slice(2)
if (sourceDirectory === undefined || targetDirectory === undefined) {
  throw new Error('Usage: render-wecom-preset.mjs <source-directory> <target-directory>')
}

const sourceAgent = await readFile(join(sourceDirectory, 'agent.cordis.yml'), 'utf8')
const sourcePersona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`
const channelPersona = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent serving an unattended enterprise WeCom text channel. Answer directly and never request interactive input. Your working directory is {{cwd}}.`
const sourceAskUser = `- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'`
const disabledAskUser = `- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  disabled: true`

function replaceExactlyOnce(document, source, replacement, label) {
  const first = document.indexOf(source)
  if (first < 0 || document.indexOf(source, first + source.length) >= 0) {
    throw new Error(`Expected exactly one ${label} block in the shipped standard preset`)
  }
  return document.replace(source, replacement)
}

let agent = replaceExactlyOnce(sourceAgent, sourcePersona, channelPersona, 'persona')
agent = replaceExactlyOnce(agent, sourceAskUser, disabledAskUser, 'tool-ask-user')

await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
await writeFile(join(targetDirectory, 'agent.cordis.yml'), agent, { mode: 0o600 })
await writeFile(join(targetDirectory, 'preset.yml'), `name: Trader Ops 企业微信无人值守模式
description: 使用受限工具且不发起交互式提问的企业微信长连接 Agent。
order: 50
`, { mode: 0o600 })
