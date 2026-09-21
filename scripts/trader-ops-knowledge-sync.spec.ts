import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error The deployment entrypoint is intentionally executable plain ESM.
import * as publisher from '../deployments/trader-ops/scripts/sync-knowledge.mjs'

interface KnowledgeDocument {
  absolutePath: string
  content: string
  metadata: Record<string, unknown>
  relativePath: string
  sha256: string
}

interface KnowledgeState {
  version: number
  resources: Record<string, { sha256: string; uri: string }>
}

const {
  buildPlan,
  discoverKnowledge,
  parseArguments,
  publishDocument,
  readState,
  writeState,
} = publisher as {
  buildPlan: (documents: KnowledgeDocument[], state: KnowledgeState) => {
    actions: Array<KnowledgeDocument & { kind: string; uri: string }>
    stale: Array<{ relativePath: string; uri: string }>
  }
  discoverKnowledge: (root: string) => Promise<KnowledgeDocument[]>
  parseArguments: (argv: string[], environment: Record<string, string>) => unknown
  publishDocument: (
    document: KnowledgeDocument & { uri?: string },
    options: { apiKey: string; endpoint: string; timeoutSeconds: number },
  ) => Promise<{ status: string }>
  readState: (path: string) => Promise<KnowledgeState>
  writeState: (path: string, state: KnowledgeState) => Promise<void>
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Trader Ops knowledge publishing', () => {
  it('discovers only approved non-empty deployment knowledge', async () => {
    const root = await temporaryRoot()
    await writeKnowledge(root, 'business/product-definition.md', approvedKnowledge('Product definition'))
    await writeKnowledge(root, 'business/draft.md', draftKnowledge())
    await writeKnowledge(root, 'business/README.md', '# Documentation only\n')
    await writeKnowledge(root, 'systems/empty.md', ' \n')

    const documents = await discoverKnowledge(root)

    expect(documents.map(document => document.relativePath)).toEqual(['business/product-definition.md'])
    expect(documents[0]?.metadata).toMatchObject({ status: 'approved', domain: 'trading' })
    expect(documents[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects incomplete approved knowledge before publication', async () => {
    const root = await temporaryRoot()
    await writeKnowledge(root, 'business/broken.md', `---
type: glossary
domain: trading
status: approved
updated_at: "2026-09-18"
tags: [product]
---

# Broken
`)

    await expect(discoverKnowledge(root)).rejects.toThrow('approved knowledge requires owner')
  })

  it('plans create, update, unchanged, and stale resources deterministically', () => {
    const documents = [
      document('business/create.md', 'new'),
      document('business/update.md', 'new'),
      document('systems/same.md', 'same'),
    ]
    const state: KnowledgeState = {
      version: 1,
      resources: {
        'business/update.md': { sha256: 'old', uri: target('business/update.md') },
        'runbooks/stale.md': { sha256: 'old', uri: target('runbooks/stale.md') },
        'systems/same.md': { sha256: 'same', uri: target('systems/same.md') },
      },
    }

    const plan = buildPlan(documents, state)

    expect(plan.actions.map(action => [action.relativePath, action.kind])).toEqual([
      ['business/create.md', 'create'],
      ['business/update.md', 'update'],
      ['systems/same.md', 'unchanged'],
    ])
    expect(plan.stale.map(entry => entry.relativePath)).toEqual(['runbooks/stale.md'])
  })

  it('uploads a file to its exact URI', async () => {
    const requests: Array<{
      body: string
      headers: Record<string, string | string[] | undefined>
      method: string | undefined
      url: string | undefined
    }> = []
    const server = createServer((request, response) => {
      void handleRequest(request, response)
    })
    async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      requests.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
        method: request.method,
        url: request.url,
      })
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/api/v1/resources/temp_upload') {
        response.end(JSON.stringify({ status: 'ok', result: { temp_file_id: 'upload-1' } }))
      } else {
        response.end(JSON.stringify({ status: 'ok', result: { status: 'success', root_uri: target('business/product.md') } }))
      }
    }
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port')
    try {
      const result = await publishDocument(
        {
          ...document('business/product.md', 'hash'),
          content: approvedKnowledge('Product'),
          metadata: {
            domain: 'trading',
            owner: 'trading-operations',
            tags: ['product'],
            type: 'glossary',
          },
          uri: target('business/product.md'),
        },
        {
          apiKey: 'secret-key',
          endpoint: `http://127.0.0.1:${address.port}`,
          timeoutSeconds: 5,
        },
      )
      expect(result.status).toBe('success')
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => {
        if (error) reject(error)
        else resolvePromise()
      }))
    }

    expect(requests.map(request => request.url)).toEqual([
      '/api/v1/resources/temp_upload',
      '/api/v1/resources',
    ])
    expect(requests.every(request => request.headers['x-api-key'] === 'secret-key')).toBe(true)
    expect(JSON.parse(requests[1]?.body ?? '')).toMatchObject({
      temp_file_id: 'upload-1',
      to: target('business/product.md'),
      wait: true,
      strict: true,
      processing_mode: 'semantic_and_vectors',
      tags: ['domain:trading', 'owner:trading-operations', 'product', 'type:glossary'],
      args: { parse_mode: 'no_split' },
    })
  })

  it('writes and reads versioned state atomically', async () => {
    const root = await temporaryRoot()
    const stateFile = join(root, 'state', 'knowledge.json')
    const state: KnowledgeState = {
      version: 1,
      resources: {
        'business/product.md': { sha256: 'hash', uri: target('business/product.md') },
      },
    }

    await writeState(stateFile, state)

    expect(await readState(stateFile)).toEqual(state)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(state)
  })

  it('requires persistent state before apply mode', () => {
    expect(() => parseArguments(['--apply'], {})).toThrow('--apply requires --state')
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trader-ops-knowledge-'))
  temporaryDirectories.push(root)
  return root
}

async function writeKnowledge(root: string, relativePath: string, content: string): Promise<void> {
  const file = join(root, relativePath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

function approvedKnowledge(title: string): string {
  return `---
type: glossary
domain: trading
owner: trading-operations
status: approved
updated_at: "2026-09-18"
tags: [product]
---

# ${title}

Stable approved knowledge.
`
}

function draftKnowledge(): string {
  return `---
type: glossary
domain: TODO
owner: TODO
status: draft
updated_at: "2026-09-18"
tags: []
---

# Draft

TODO
`
}

function document(relativePath: string, hash: string): KnowledgeDocument {
  return {
    absolutePath: `/tmp/${relativePath}`,
    content: 'content',
    metadata: {},
    relativePath,
    sha256: hash,
  }
}

function target(relativePath: string): string {
  return `viking://resources/trader-ops/knowledge/${relativePath}`
}
