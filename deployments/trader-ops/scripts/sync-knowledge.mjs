#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEPLOYMENT_ROOT = resolve(SCRIPT_DIRECTORY, '..')
const DEFAULT_KNOWLEDGE_ROOT = join(DEPLOYMENT_ROOT, 'knowledge')
const DEFAULT_TARGET_ROOT = 'viking://resources/trader-ops/knowledge'
const STATE_VERSION = 1
const REQUIRED_DIRECTORIES = new Set(['business', 'systems', 'runbooks'])
const SAFE_RELATIVE_PATH = /^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.md$/

/** Parse and validate the command-line options used by the publisher. */
export function parseArguments(argv, environment = process.env) {
  const options = {
    apply: false,
    endpoint: environment.OPENVIKING_URL ?? 'http://127.0.0.1:1933',
    knowledgeRoot: DEFAULT_KNOWLEDGE_ROOT,
    stateFile: environment.TRADER_OPS_KNOWLEDGE_STATE_FILE
      ?? (environment.DSH_HOME
        ? join(environment.DSH_HOME, 'knowledge-sync', 'trader-ops.json')
        : undefined),
    targetRoot: environment.TRADER_OPS_KNOWLEDGE_TARGET_ROOT ?? DEFAULT_TARGET_ROOT,
    timeoutSeconds: 300,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--apply') options.apply = true
    else if (argument === '--help') options.help = true
    else if (argument === '--endpoint') options.endpoint = requiredValue(argv, ++index, argument)
    else if (argument === '--knowledge-root') options.knowledgeRoot = resolve(requiredValue(argv, ++index, argument))
    else if (argument === '--state') options.stateFile = resolve(requiredValue(argv, ++index, argument))
    else if (argument === '--target-root') options.targetRoot = requiredValue(argv, ++index, argument)
    else if (argument === '--timeout') options.timeoutSeconds = parsePositiveInteger(requiredValue(argv, ++index, argument), argument)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  options.targetRoot = validateTargetRoot(options.targetRoot)
  validateEndpoint(options.endpoint)
  if (options.apply && options.stateFile === undefined) {
    throw new Error('--apply requires --state, TRADER_OPS_KNOWLEDGE_STATE_FILE, or DSH_HOME')
  }
  return options
}

/** Discover approved knowledge documents and validate their publishing metadata. */
export async function discoverKnowledge(knowledgeRoot) {
  const root = resolve(knowledgeRoot)
  const documents = []
  for (const directory of [...REQUIRED_DIRECTORIES].sort()) {
    const directoryPath = join(root, directory)
    if (!existsSync(directoryPath)) continue
    await walk(directoryPath, async (absolutePath) => {
      const relativePath = relative(root, absolutePath).split(sep).join('/')
      if (isExcluded(relativePath)) return
      if (!SAFE_RELATIVE_PATH.test(relativePath)) {
        throw new Error(`${relativePath}: knowledge paths must use lowercase ASCII slugs`)
      }
      const content = await readFile(absolutePath, 'utf8')
      if (content.trim() === '') return
      const parsed = parseKnowledgeDocument(content, relativePath)
      if (parsed.metadata.status === 'draft') return
      documents.push({
        absolutePath,
        content,
        metadata: parsed.metadata,
        relativePath,
        sha256: sha256(content),
      })
    })
  }
  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

/** Build an idempotent create/update/unchanged plan plus non-destructive stale findings. */
export function buildPlan(documents, state, targetRoot = DEFAULT_TARGET_ROOT) {
  const byPath = new Map(documents.map(document => [document.relativePath, document]))
  const actions = documents.map((document) => {
    const uri = `${targetRoot}/${document.relativePath}`
    const previous = state.resources[document.relativePath]
    const kind = previous === undefined
      ? 'create'
      : previous.sha256 === document.sha256 && previous.uri === uri
        ? 'unchanged'
        : 'update'
    return { ...document, kind, uri }
  })
  const stale = Object.entries(state.resources)
    .filter(([relativePath]) => !byPath.has(relativePath))
    .map(([relativePath, entry]) => ({ relativePath, ...entry }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { actions, stale }
}

/** Read publisher state; a missing file represents a first publication. */
export async function readState(stateFile) {
  if (stateFile === undefined || !existsSync(stateFile)) return emptyState()
  const value = JSON.parse(await readFile(stateFile, 'utf8'))
  if (value?.version !== STATE_VERSION || !isPlainObject(value.resources)) {
    throw new Error(`${stateFile}: unsupported or invalid knowledge sync state`)
  }
  for (const [relativePath, entry] of Object.entries(value.resources)) {
    if (!SAFE_RELATIVE_PATH.test(relativePath)
      || !isPlainObject(entry)
      || typeof entry.sha256 !== 'string'
      || typeof entry.uri !== 'string') {
      throw new Error(`${stateFile}: invalid state entry for ${relativePath}`)
    }
  }
  return value
}

/** Atomically persist non-secret publication state with owner-only permissions. */
export async function writeState(stateFile, state) {
  const stateDirectory = dirname(stateFile)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  const temporary = `${stateFile}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, stateFile)
}

/** Upload one Markdown file to its exact OpenViking URI and await indexing. */
export async function publishDocument(document, options) {
  const headers = { 'X-API-Key': options.apiKey }
  const form = new FormData()
  form.append(
    'file',
    new Blob([document.content], { type: 'text/markdown; charset=utf-8' }),
    basename(document.relativePath),
  )
  const upload = await requestJson(
    new URL('/api/v1/resources/temp_upload', options.endpoint),
    { method: 'POST', headers, body: form },
    options.timeoutSeconds,
  )
  const tempFileId = upload?.result?.temp_file_id
  if (typeof tempFileId !== 'string' || tempFileId === '') {
    throw new Error(`${document.relativePath}: OpenViking returned no temp_file_id`)
  }
  const ingestion = await requestJson(
    new URL('/api/v1/resources', options.endpoint),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        temp_file_id: tempFileId,
        to: document.uri,
        create_parent: true,
        wait: true,
        timeout: options.timeoutSeconds,
        strict: true,
        processing_mode: 'semantic_and_vectors',
        tags: resourceTags(document.metadata),
        args: { parse_mode: 'no_split' },
      }),
    },
    options.timeoutSeconds + 5,
  )
  const status = ingestion?.result?.status
  if (status === 'success') return ingestion.result
  if (status === 'accepted' && typeof ingestion.result.task_id === 'string') {
    return await waitForTask(
      ingestion.result.task_id,
      headers,
      options.endpoint,
      options.timeoutSeconds,
      options.pollIntervalMs ?? 1000,
    )
  }
  throw new Error(`${document.relativePath}: OpenViking ingestion did not succeed`)
}

/** Apply changed resources sequentially and checkpoint each completed publication. */
export async function applyPlan(plan, state, options) {
  const nextState = structuredClone(state)
  for (const document of plan.actions) {
    if (document.kind === 'unchanged') continue
    const result = await publishDocument(document, options)
    nextState.resources[document.relativePath] = {
      sha256: document.sha256,
      uri: document.uri,
      taskId: typeof result.task_id === 'string' ? result.task_id : undefined,
      publishedAt: new Date().toISOString(),
    }
    await writeState(options.stateFile, nextState)
    console.log(`${document.kind}: ${document.relativePath} -> ${document.uri}`)
  }
  return nextState
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  const documents = await discoverKnowledge(options.knowledgeRoot)
  const state = await readState(options.stateFile)
  const plan = buildPlan(documents, state, options.targetRoot)
  printPlan(plan)
  if (!options.apply) return

  const apiKey = process.env.OPENVIKING_API_KEY
  if (apiKey === undefined || apiKey === '') {
    throw new Error('--apply requires OPENVIKING_API_KEY')
  }
  const lockFile = `${options.stateFile}.lock`
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 })
  let lock
  try {
    lock = await open(lockFile, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Knowledge sync is already running: ${lockFile}`)
    throw error
  }
  try {
    await applyPlan(plan, state, { ...options, apiKey })
  } finally {
    await lock.close()
    await rm(lockFile, { force: true })
  }
  if (plan.stale.length > 0) {
    console.warn('Stale resources remain published; this MVP never deletes OpenViking content.')
  }
}

function parseKnowledgeDocument(content, relativePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match === null) throw new Error(`${relativePath}: missing YAML frontmatter`)
  const metadata = yaml.load(match[1])
  if (!isPlainObject(metadata)) throw new Error(`${relativePath}: frontmatter must be a mapping`)
  if (metadata.status !== 'draft' && metadata.status !== 'approved') {
    throw new Error(`${relativePath}: status must be draft or approved`)
  }
  if (metadata.status === 'approved') {
    for (const field of ['type', 'domain', 'owner']) {
      if (typeof metadata[field] !== 'string' || metadata[field].trim() === '' || metadata[field].includes('TODO')) {
        throw new Error(`${relativePath}: approved knowledge requires ${field}`)
      }
    }
    if (typeof metadata.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(metadata.updated_at)) {
      throw new Error(`${relativePath}: approved knowledge requires updated_at: YYYY-MM-DD`)
    }
    if (!Array.isArray(metadata.tags) || metadata.tags.length === 0
      || metadata.tags.some(tag => typeof tag !== 'string' || tag.trim() === '')) {
      throw new Error(`${relativePath}: approved knowledge requires non-empty string tags`)
    }
    if (match[2].trim() === '' || /\bTODO\b/.test(match[2])) {
      throw new Error(`${relativePath}: approved knowledge cannot be empty or contain TODO`)
    }
  }
  return { metadata, body: match[2] }
}

async function walk(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`${entryPath}: knowledge symlinks are not allowed`)
    if (entry.isDirectory()) await walk(entryPath, visit)
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stats = await lstat(entryPath)
      if (!stats.isFile()) throw new Error(`${entryPath}: expected a regular file`)
      await visit(entryPath)
    }
  }
}

function isExcluded(relativePath) {
  const name = basename(relativePath)
  return name === 'README.md' || name === 'README.zh.md' || name.endsWith('.i18n.md')
}

function emptyState() {
  return { version: STATE_VERSION, resources: {} }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function resourceTags(metadata) {
  return [...new Set([
    ...metadata.tags,
    `domain:${metadata.domain}`,
    `type:${metadata.type}`,
    `owner:${metadata.owner}`,
  ])].sort()
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredValue(argv, index, option) {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer`)
  return parsed
}

function validateTargetRoot(value) {
  const trimmed = value.replace(/\/+$/, '')
  if (!/^viking:\/\/resources\/[a-z0-9][a-z0-9._/-]*$/.test(trimmed)) {
    throw new Error('--target-root must be below viking://resources/ and use lowercase ASCII slugs')
  }
  return trimmed
}

function validateEndpoint(value) {
  const endpoint = new URL(value)
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('OpenViking endpoint must use HTTP or HTTPS')
  if (endpoint.username !== '' || endpoint.password !== '') throw new Error('OpenViking endpoint must not contain credentials')
}

async function requestJson(url, init, timeoutSeconds) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutSeconds * 1000) })
  if (!response.ok) throw new Error(`OpenViking ${init.method} ${url.pathname} failed with HTTP ${response.status}`)
  const payload = await response.json()
  if (payload?.status !== 'ok') throw new Error(`OpenViking ${init.method} ${url.pathname} returned an error`)
  return payload
}

async function waitForTask(taskId, headers, endpoint, timeoutSeconds, pollIntervalMs) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const task = await requestJson(
      new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, endpoint),
      { method: 'GET', headers },
      Math.min(timeoutSeconds, 30),
    )
    const status = task?.result?.status
    if (status === 'completed') {
      if (task.result.result?.status === 'error') throw new Error(`OpenViking task ${taskId} failed`)
      return task.result
    }
    if (['failed', 'error', 'cancelled'].includes(status)) throw new Error(`OpenViking task ${taskId} failed`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollIntervalMs))
  }
  throw new Error(`OpenViking task ${taskId} did not complete within ${timeoutSeconds} seconds`)
}

function printPlan(plan) {
  const changed = plan.actions.filter(action => action.kind !== 'unchanged')
  console.log(`Knowledge plan: ${changed.length} change(s), ${plan.actions.length - changed.length} unchanged, ${plan.stale.length} stale.`)
  for (const action of changed) console.log(`${action.kind}: ${action.relativePath} -> ${action.uri}`)
  for (const entry of plan.stale) console.log(`stale: ${entry.relativePath} -> ${entry.uri}`)
}

function printHelp() {
  console.log(`Usage: node sync-knowledge.mjs [options]

Default mode is read-only planning. Approved non-empty Markdown is published only with --apply.

Options:
  --apply                 Upload create/update actions; never deletes stale resources
  --endpoint URL          OpenViking endpoint (default: OPENVIKING_URL or loopback)
  --knowledge-root PATH   Knowledge source root
  --state PATH            Persistent publisher state file
  --target-root URI       OpenViking target root
  --timeout SECONDS       Per-resource ingestion timeout (default: 300)
  --help                  Show this help

OPENVIKING_API_KEY is read only for --apply and is never written to state.`)
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`sync-knowledge: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
