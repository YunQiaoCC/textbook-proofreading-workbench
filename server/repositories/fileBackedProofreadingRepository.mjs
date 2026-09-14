import path from 'node:path'
import { rm } from 'node:fs/promises'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'
import { DocumentLifecycleCoordinator, DocumentNotFoundError } from '../services/documentLifecycleCoordinator.mjs'

function validDocumentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

function validChapterId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export class ProofreadingRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('proofreading workspace revision conflict')
    this.name = 'ProofreadingRevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class FileBackedProofreadingRepository {
  constructor(storageRoot, { now = () => new Date(), lifecycleCoordinator = new DocumentLifecycleCoordinator(), documentExists = null } = {}) {
    this.metadataRoot = path.resolve(storageRoot, 'metadata', 'proofreading')
    this.now = now
    this.lifecycleCoordinator = lifecycleCoordinator
    this.documentExists = documentExists
  }

  async init() {
    await ensureDirectory(this.metadataRoot)
  }

  recordPath(documentId) {
    if (!validDocumentId(documentId)) throw new Error('Invalid document identifier')
    const recordPath = path.resolve(this.metadataRoot, `${documentId}.json`)
    if (!isWithinRoot(this.metadataRoot, recordPath)) {
      throw new Error('Proofreading metadata path escapes root')
    }
    return recordPath
  }

  chapterRecordPath(documentId, chapterId) {
    if (!validDocumentId(documentId)) throw new Error('Invalid document identifier')
    if (!validChapterId(chapterId)) throw new Error('Invalid chapter identifier')
    const recordPath = path.resolve(this.metadataRoot, documentId, `${chapterId}.json`)
    if (!isWithinRoot(this.metadataRoot, recordPath)) {
      throw new Error('Proofreading metadata path escapes root')
    }
    return recordPath
  }

  async get(documentId) {
    try {
      return await readJson(this.recordPath(documentId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async withWorkspaceLock(lockKey, operation) {
    const [scope, documentId] = String(lockKey).split(':')
    if ((scope === 'document' || scope === 'chapter') && documentId) {
      return this.lifecycleCoordinator.withDocumentLock(documentId, operation)
    }
    throw new Error('Invalid proofreading lock key')
  }

  async withDocumentLock(documentId, operation) {
    return this.withWorkspaceLock(`document:${documentId}`, operation)
  }

  async ensureDocumentExists(documentId) {
    if (this.documentExists && !(await this.documentExists(documentId))) {
      throw new DocumentNotFoundError(documentId)
    }
  }

  async save(documentId, workspace, expectedRevision) {
    // Legacy/document-scope record retained for compatibility.
    this.recordPath(documentId)
    return this.withDocumentLock(documentId, async () => {
      await this.ensureDocumentExists(documentId)
      const current = await this.get(documentId)
      const currentRevision = current?.revision ?? 0
      if (expectedRevision !== currentRevision) {
        throw new ProofreadingRevisionConflictError(currentRevision)
      }

      const now = this.now().toISOString()
      const nextWorkspace = {
        schemaVersion: 1,
        documentId,
        revision: currentRevision + 1,
        annotations: workspace.annotations,
        issues: workspace.issues,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(this.recordPath(documentId), nextWorkspace)
      return nextWorkspace
    })
  }

  async getChapter(documentId, chapterId) {
    try {
      return await readJson(this.chapterRecordPath(documentId, chapterId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async saveChapter(documentId, chapterId, workspace, expectedRevision) {
    const recordPath = this.chapterRecordPath(documentId, chapterId)
    return this.withWorkspaceLock('chapter:' + documentId + ':' + chapterId, async () => {
      await this.ensureDocumentExists(documentId)
      const current = await this.getChapter(documentId, chapterId)
      const currentRevision = current?.revision ?? 0
      if (expectedRevision !== currentRevision) {
        throw new ProofreadingRevisionConflictError(currentRevision)
      }

      const now = this.now().toISOString()
      const nextWorkspace = {
        schemaVersion: 1,
        documentId,
        chapterId,
        revision: currentRevision + 1,
        annotations: workspace.annotations,
        issues: workspace.issues,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      }
      await atomicWriteJson(recordPath, nextWorkspace)
      return nextWorkspace
    })
  }

  async removeDocumentFiles(documentId) {
    await rm(this.recordPath(documentId), { force: true })
    const chapterDirectory = path.resolve(this.metadataRoot, documentId)
    if (!isWithinRoot(this.metadataRoot, chapterDirectory)) {
      throw new Error('Proofreading metadata path escapes root')
    }
    await rm(chapterDirectory, { recursive: true, force: true })
  }

  async removeChapterFiles(documentId, chapterId) {
    await rm(this.chapterRecordPath(documentId, chapterId), { force: true })
  }
}
