/** Reviewed message-source compatibility for the pinned OpenViking deployment plugin. */
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const edits = {
  'runtime.mjs': [
    ['      kind: "plugin",\n      plugin: OPENVIKING_PLUGIN_SOURCE,', '      kind: `plugin:${OPENVIKING_PLUGIN_SOURCE}`,'],
    ['message?.source?.kind === "plugin"\n    && message.source.plugin === OPENVIKING_PLUGIN_SOURCE', 'message?.source?.kind === `plugin:${OPENVIKING_PLUGIN_SOURCE}`'],
  ],
  'capture.mjs': [
    ['if (message.source?.kind === "plugin") return null;', 'if (!["user", "model", "tool"].includes(message.source?.kind)) return null;'],
    ['message?.source?.kind === "plugin"\n      && message.source.plugin === OPENVIKING_PLUGIN_SOURCE', 'message?.source?.kind === `plugin:${OPENVIKING_PLUGIN_SOURCE}`'],
  ],
}

function occurrences(source, text) {
  return source.split(text).length - 1
}

/**
 * Admit current producer attribution and keep synthetic context out of memory capture.
 * All reviewed replacements are checked before any file changes; unknown versions or source fail closed.
 * @param packageDirectory - Installed OpenViking package directory.
 * @param verify - Refuse missing patches without writing files.
 * @returns number of changed files, or zero when the installed sources already match.
 */
export async function patchOpenVikingMessageSources(packageDirectory, verify = false) {
  const manifest = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'))
  if (manifest.version !== '0.3.0') throw new Error('OpenViking message-source patch requires reviewed version 0.3.0')
  const pending = []
  for (const [file, replacements] of Object.entries(edits)) {
    const path = resolve(packageDirectory, file)
    const original = await readFile(path, 'utf8')
    let source = original
    for (const [before, after] of replacements) {
      if (occurrences(source, before) === 0 && occurrences(source, after) === 1) continue
      if (occurrences(source, before) !== 1 || occurrences(source, after) !== 0) {
        throw new Error(`OpenViking 0.3.0 ${file} message-source code differs from the reviewed source`)
      }
      source = source.replace(before, after)
    }
    if (source !== original) pending.push({ path, source })
  }
  if (verify && pending.length > 0) throw new Error('OpenViking message-source compatibility patch is missing; rerun profile bootstrap')
  for (const { path, source } of pending) {
    const temporary = `${path}.trader-ops-${randomUUID()}`
    await writeFile(temporary, source, { mode: (await stat(path)).mode, flag: 'wx' })
    await rename(temporary, path)
  }
  return pending.length
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  const args = process.argv.slice(2)
  const verify = args[0] === '--verify'
  const directory = args[verify ? 1 : 0]
  if (directory === undefined || args.length !== (verify ? 2 : 1)) {
    throw new Error('Usage: patch-openviking-message-sources.mjs [--verify] <package-directory>')
  }
  await patchOpenVikingMessageSources(directory, verify)
}
