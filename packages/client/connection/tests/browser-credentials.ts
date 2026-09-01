import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials {
  record: CredentialRecord | undefined
  readonly references = new Map<string, string>()
  discardWrites = false
  reads = 0
  modifies = 0

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.references.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  readRecord(): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.record)
  }

  async modifyRecord(
    _key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.record)
    if (this.discardWrites) return undefined
    if (next !== undefined) this.record = next
    return this.record
  }

  deleteRecord(): Promise<void> {
    this.record = undefined
    return Promise.resolve()
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
}
