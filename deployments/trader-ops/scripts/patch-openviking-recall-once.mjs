#!/usr/bin/env node

import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const supportedVersion = '0.3.0'
const originalHandler = 'ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {'
const patchedHandler = 'ctx.on("agent/pre-step", async ({ agent, messages, signal, step }, next) => {'
const originalDecision = '    if (decision.kind !== "enter" || signal.aborted) return decision;'
const patchedDecision = `${originalDecision}\n    if (step !== 1) return decision;`

function replaceExactlyOnce(source, original, replacement, label) {
  const first = source.indexOf(original)
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error(`OpenViking ${supportedVersion} ${label} no longer matches the reviewed source`)
  }
  return source.replace(original, replacement)
}

/**
 * Limit the pinned OpenViking plugin to one profile/recall lookup per turn.
 * Exact-source checks stop bootstrap when the dependency changes instead of
 * applying a broad edit to unknown third-party code.
 */
export async function patchOpenVikingRecallOnce(packageDirectory) {
  const manifestPath = resolve(packageDirectory, 'package.json')
  const sourcePath = resolve(packageDirectory, 'index.mjs')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== supportedVersion) {
    throw new Error(
      `OpenViking recall patch supports ${supportedVersion}, got ${String(manifest.version)}`,
    )
  }

  const source = await readFile(sourcePath, 'utf8')
  const alreadyPatched = source.includes(patchedHandler) && source.includes(patchedDecision)
  if (alreadyPatched) return false

  let patched = replaceExactlyOnce(source, originalHandler, patchedHandler, 'pre-step handler')
  patched = replaceExactlyOnce(patched, originalDecision, patchedDecision, 'enter decision')
  const sourceMode = (await stat(sourcePath)).mode
  const replacementPath = `${sourcePath}.trader-ops-replacement`
  await writeFile(replacementPath, patched, { mode: sourceMode })
  await rename(replacementPath, sourcePath)
  return true
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [packageDirectory] = process.argv.slice(2)
  if (packageDirectory === undefined) {
    throw new Error('Usage: patch-openviking-recall-once.mjs <package-directory>')
  }
  await patchOpenVikingRecallOnce(packageDirectory)
}
