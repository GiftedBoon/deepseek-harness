/** Source-checked OpenViking patches preserve producer attribution and capture exclusions. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const patchScript = fileURLToPath(new URL('../deployments/trader-ops/scripts/patch-openviking-message-sources.mjs', import.meta.url))

async function patchOpenVikingMessageSources(root: string, verify = false): Promise<void> {
  await execFileAsync(process.execPath, [patchScript, ...verify ? ['--verify'] : [], root])
}

const runtime = `const OPENVIKING_PLUGIN_SOURCE = "openviking-memory";
export function message() {
  return {
    source: {
      kind: "plugin",
      plugin: OPENVIKING_PLUGIN_SOURCE,
      form: "instructions",
    },
  };
}
export function isStartupProfile(message) {
  return message?.source?.kind === "plugin"
    && message.source.plugin === OPENVIKING_PLUGIN_SOURCE
    && message.source.form === "instructions";
}
`
const capture = `const OPENVIKING_PLUGIN_SOURCE = "openviking-memory";
export function capture(message) {
  if (message.source?.kind === "plugin") return null;
  return message;
}
export function promptText(messages) {
  return messages.filter(message => !(
      message?.source?.kind === "plugin"
      && message.source.plugin === OPENVIKING_PLUGIN_SOURCE
  ));
}
`

interface Message {
  source: { kind: string; form?: string }
}

interface WriterFixture {
  message(): Message
  isStartupProfile(message: Message): boolean
}

interface CaptureFixture {
  capture(message: Message): Message | null
  promptText(messages: Message[]): Message[]
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-message-source-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.3.0' }))
    await writeFile(join(root, 'runtime.mjs'), runtime)
    await writeFile(join(root, 'capture.mjs'), capture)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('patches writing, profile recognition, prompt filtering, and synthetic-input capture together', async () => {
  await fixture(async (root) => {
    await patchOpenVikingMessageSources(root)
    const writer = await import(pathToFileURL(join(root, 'runtime.mjs')).href) as WriterFixture
    const reader = await import(pathToFileURL(join(root, 'capture.mjs')).href) as CaptureFixture
    const memory = writer.message()
    expect(memory.source).toEqual({ kind: 'plugin:openviking-memory', form: 'instructions' })
    expect(writer.isStartupProfile(memory)).toBe(true)
    expect(reader.promptText([memory, { source: { kind: 'user' } }])).toEqual([{ source: { kind: 'user' } }])
    for (const kind of ['plugin:openviking-memory', 'runtime-context', 'time-context', 'plugin', 'external-context']) {
      expect(reader.capture({ source: { kind } })).toBeNull()
    }
    for (const kind of ['user', 'model', 'tool']) {
      expect(reader.capture({ source: { kind } })).toEqual({ source: { kind } })
    }
    const files = await Promise.all(['runtime.mjs', 'capture.mjs'].map(file => readFile(join(root, file), 'utf8')))
    await patchOpenVikingMessageSources(root)
    await patchOpenVikingMessageSources(root, true)
    expect(await Promise.all(['runtime.mjs', 'capture.mjs'].map(file => readFile(join(root, file), 'utf8')))).toEqual(files)
  })
})

test('verification refuses an unpatched installation without changing files', async () => {
  await fixture(async (root) => {
    await expect(patchOpenVikingMessageSources(root, true)).rejects.toThrow('compatibility patch is missing')
    expect(await readFile(join(root, 'runtime.mjs'), 'utf8')).toBe(runtime)
    expect(await readFile(join(root, 'capture.mjs'), 'utf8')).toBe(capture)
  })
})

test.each(['changed', 'duplicate', 'unsupported'])('refuses %s dependency code before rewriting either file', async (mode) => {
  await fixture(async (root) => {
    const source = mode === 'changed' ? capture.replace('return null;', 'return undefined;') : mode === 'duplicate' ? capture + capture : capture
    await writeFile(join(root, 'capture.mjs'), source)
    if (mode === 'unsupported') await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.4.0' }))
    await expect(patchOpenVikingMessageSources(root)).rejects.toThrow(/reviewed/)
    expect(await readFile(join(root, 'runtime.mjs'), 'utf8')).toBe(runtime)
    expect(await readFile(join(root, 'capture.mjs'), 'utf8')).toBe(source)
  })
})
