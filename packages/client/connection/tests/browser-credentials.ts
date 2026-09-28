import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials extends CredentialProvider {
  constructor(ctx = new Context()) { super(ctx) }
  async describe(): Promise<never> { throw new Error('describe is not used by this fixture') }
  async set(): Promise<never> { throw new Error('set is not used by this fixture') }
  async unset(): Promise<never> { throw new Error('unset is not used by this fixture') }
  async describeRecord(): Promise<never> { throw new Error('describeRecord is not used by this fixture') }
  async listRecords(): Promise<never> { throw new Error('listRecords is not used by this fixture') }
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
  new RecordCredentials(ctx)
}
