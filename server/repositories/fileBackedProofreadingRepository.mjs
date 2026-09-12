import path from 'node:path'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'

function validDocumentId(value) {
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
  constructor(storageRoot, { now = () => new Date() } = {}) {
    this.metadataRoot = path.resolve(storageRoot, 'metadata', 'proofreading')
    this.now = now
    this.locks = new Map()
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

  async get(documentId) {
    try {
      return await readJson(this.recordPath(documentId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async withDocumentLock(documentId, operation) {
    const previous = this.locks.get(documentId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.locks.set(documentId, current)
    try {
      return await current
    } finally {
      if (this.locks.get(documentId) === current) this.locks.delete(documentId)
    }
  }

  async save(documentId, workspace, expectedRevision) {
    this.recordPath(documentId)
    return this.withDocumentLock(documentId, async () => {
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
}
