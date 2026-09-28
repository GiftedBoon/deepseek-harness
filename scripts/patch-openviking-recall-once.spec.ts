import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const execFileAsync = promisify(execFile)
const patchScript = resolve(dirname(fileURLToPath(import.meta.url)), '../deployments/trader-ops/scripts/patch-openviking-recall-once.mjs')

test('patches OpenViking when the script is launched through a release symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-openviking-'))
  try {
    const current = join(root, 'current')
    const plugin = join(root, 'plugin')
    await mkdir(plugin)
    await symlink(dirname(patchScript), current, 'junction')
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ version: '0.3.0' }))
    await writeFile(join(plugin, 'index.mjs'), [
      'ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {',
      '    if (decision.kind !== "enter" || signal.aborted) return decision;',
    ].join('\n'))

    await execFileAsync(process.execPath, [join(current, 'patch-openviking-recall-once.mjs'), plugin])

    const source = await readFile(join(plugin, 'index.mjs'), 'utf8')
    expect(source).toContain('async ({ agent, messages, signal, step }, next)')
    expect(source).toContain('if (step !== 1) return decision;')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
