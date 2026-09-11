import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

export class FileBackedDocumentRepository {
  constructor(storageRoot) {
    this.metadataRoot = path.join(storageRoot, 'metadata', 'documents')
  }

  async init() {
    await ensureDirectory(this.metadataRoot)
  }

  recordPath(documentId) {
    if (!validIdentifier(documentId)) {
      throw new Error('Invalid document identifier')
    }
    return path.join(this.metadataRoot, `${documentId}.json`)
  }

  async readRecord(documentId) {
    try {
      return await readJson(this.recordPath(documentId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async writeRecord(record) {
    await atomicWriteJson(this.recordPath(record.document.id), {
      document: record.document,
      asset: record.asset ?? null,
      pages: record.pages ?? [],
      chapters: record.chapters ?? [],
      inspectionSummary: record.inspectionSummary ?? null,
    })
  }

  async saveBundle({ document, asset, pages, chapters = [], inspectionSummary = null }) {
    await this.writeRecord({ document, asset, pages, chapters, inspectionSummary })
  }

  async save(document) {
    const existing = await this.readRecord(document.id)
    await this.writeRecord({
      ...(existing ?? {}),
      document,
    })
  }

  async saveAsset(asset) {
    const existing = await this.readRecord(asset.documentId)
    if (!existing) throw new Error(`Document metadata not found: ${asset.documentId}`)
    await this.writeRecord({ ...existing, asset })
  }

  async savePages(documentId, pages) {
    const existing = await this.readRecord(documentId)
    if (!existing) throw new Error(`Document metadata not found: ${documentId}`)
    await this.writeRecord({ ...existing, pages })
  }

  async getById(documentId) {
    return (await this.readRecord(documentId))?.document ?? null
  }

  async listPages(documentId) {
    return (await this.readRecord(documentId))?.pages ?? []
  }

  async listChapters(documentId) {
    return (await this.readRecord(documentId))?.chapters ?? []
  }

  async getAsset(assetId) {
    const records = await readdir(this.metadataRoot, { withFileTypes: true })
    for (const entry of records) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const record = await readJson(path.join(this.metadataRoot, entry.name))
      if (record.asset?.id === assetId) return record.asset
    }
    return null
  }
}
