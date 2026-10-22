import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { migrationVersionSelect, planVersionLabels } from './version-labels.js'
import { entryVersionMetadataBatch } from '../lib/version-policy.js'

describe('version migration projections and bounded metadata reads', () => {
  it('never selects package bytes or unrelated presentation fields for a plan', async () => {
    const tx = { skill: { findMany: vi.fn().mockResolvedValue([]) }, libraryEntry: { findMany: vi.fn().mockResolvedValue([]) }, skillVersionLabelAlias: { findMany: vi.fn().mockResolvedValue([]) } }
    const client = { $transaction: async (fn: (value: typeof tx) => unknown): Promise<unknown> => fn(tx) } as unknown as PrismaClient
    await planVersionLabels(client, 30)
    expect(tx.skill.findMany.mock.calls[0]?.[0].select.versions.select).toBe(migrationVersionSelect)
    expect(Object.keys(migrationVersionSelect).sort()).toEqual(['cardSha256', 'createdAt', 'id', 'mutationDigest', 'packageSha256', 'skillId', 'version'].sort())
    expect(JSON.stringify(tx.skill.findMany.mock.calls)).not.toMatch(/packageData|sourceContent|description|updatedAt|installCount/)
  })

  it('loads all entry receipts and author high-water metadata in two batch calls', async () => {
    const tx = { libraryEntryVersion: { findMany: vi.fn().mockResolvedValue([]) }, skill: { findMany: vi.fn().mockResolvedValue([{ id: 'author', versionHighWater: 42, versions: [], libraryEntries: [] }]) } }
    const entries = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), authorSkillId: 'author', versionHighWater: -1, currentVersionReceiptId: null }))
    const metadata = await entryVersionMetadataBatch(tx as unknown as Parameters<typeof entryVersionMetadataBatch>[0], entries as Parameters<typeof entryVersionMetadataBatch>[1])
    expect(metadata.size).toBe(1000)
    expect(metadata.get('999')?.versionHighWater).toBe(42)
    expect(tx.libraryEntryVersion.findMany).toHaveBeenCalledOnce()
    expect(tx.skill.findMany).toHaveBeenCalledOnce()
    expect(JSON.stringify(tx.libraryEntryVersion.findMany.mock.calls)).not.toContain('packageData')
  })
})
