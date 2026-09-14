import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'
import { DocumentLifecycleCoordinator, DocumentNotFoundError } from '../services/documentLifecycleCoordinator.mjs'

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  )
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

export class FileBackedDocumentRepository {
  constructor(storageRoot, { lifecycleCoordinator = new DocumentLifecycleCoordinator() } = {}) {
    this.metadataRoot = path.resolve(storageRoot, 'metadata', 'documents')
    this.lifecycleCoordinator = lifecycleCoordinator
  }

  async init() {
    await ensureDirectory(this.metadataRoot)
  }

  recordPath(documentId) {
    if (!validIdentifier(documentId)) {
      throw new Error('Invalid document identifier')
    }
    const recordPath = path.resolve(this.metadataRoot, documentId + '.json')
    if (!isWithinRoot(this.metadataRoot, recordPath)) {
      throw new Error('Document metadata path escapes root')
    }
    return recordPath
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

  async saveBundle({ document, asset, pages, chapters = [], inspectionSummary = null, requireExisting = false }) {
    return this.withDocumentLock(document.id, async () => {
      if (requireExisting && !(await this.readRecord(document.id))) {
        throw new DocumentNotFoundError(document.id)
      }
      await this.writeRecord({ document, asset, pages, chapters, inspectionSummary })
    })
  }

  async save(document) {
    return this.withDocumentLock(document.id, async () => {
      const existing = await this.readRecord(document.id)
      if (!existing) throw new DocumentNotFoundError(document.id)
      await this.writeRecord({
        ...existing,
        document,
      })
    })
  }

  async saveAsset(asset) {
    return this.withDocumentLock(asset.documentId, async () => {
      const existing = await this.readRecord(asset.documentId)
      if (!existing) throw new DocumentNotFoundError(asset.documentId)
      await this.writeRecord({ ...existing, asset })
    })
  }

  async savePages(documentId, pages) {
    return this.withDocumentLock(documentId, async () => {
      const existing = await this.readRecord(documentId)
      if (!existing) throw new DocumentNotFoundError(documentId)
      await this.writeRecord({ ...existing, pages })
    })
  }

  async withDocumentLock(documentId, operation) {
    return this.lifecycleCoordinator.withDocumentLock(documentId, operation)
  }

  async removeDocumentRecord(documentId) {
    await rm(this.recordPath(documentId), { force: true })
  }

  async getById(documentId) {
    return (await this.readRecord(documentId))?.document ?? null
  }

  async listDocuments() {
    const entries = await readdir(this.metadataRoot, { withFileTypes: true })
    const documents = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const record = await readJson(path.join(this.metadataRoot, entry.name))
        if (record.document) documents.push(record.document)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return documents.sort((left, right) => {
      const byCreatedAt = String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
      return byCreatedAt || String(left.id).localeCompare(String(right.id))
    })
  }

  async listPages(documentId) {
    return (await this.readRecord(documentId))?.pages ?? []
  }

  async listChapters(documentId) {
    return (await this.readRecord(documentId))?.chapters ?? []
  }

  async getChapter(documentId, chapterId) {
    const chapters = await this.listChapters(documentId)
    return chapters.find((chapter) => chapter.id === chapterId) ?? null
  }

  /**
   * Chapter metadata shares the existing document record and is updated under
   * a per-document lock so concurrent chapter setup requests remain atomic.
   */
  async saveChapter(documentId, chapter) {
    return this.withDocumentLock(documentId, async () => {
      const existing = await this.readRecord(documentId)
      if (!existing) throw new DocumentNotFoundError(documentId)
      const chapters = existing.chapters ?? []
      const index = chapters.findIndex((item) => item.id === chapter.id)
      const nextChapters = index === -1
        ? [...chapters, chapter]
        : chapters.map((item, itemIndex) => itemIndex === index ? chapter : item)
      await this.writeRecord({ ...existing, chapters: nextChapters })
      return chapter
    })
  }

  async removeChapter(documentId, chapterId) {
    if (!validIdentifier(chapterId)) throw new Error('Invalid chapter identifier')
    const existing = await this.readRecord(documentId)
    if (!existing) throw new DocumentNotFoundError(documentId)
    const chapters = existing.chapters ?? []
    const nextChapters = chapters.filter((chapter) => chapter.id !== chapterId)
    if (nextChapters.length === chapters.length) return false
    await this.writeRecord({ ...existing, chapters: nextChapters })
    return true
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

  async getAssetForDocument(documentId, assetId) {
    const record = await this.readRecord(documentId)
    return record?.asset?.id === assetId ? record.asset : null
  }
}
