import path from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'
import { DocumentLifecycleCoordinator, DocumentNotFoundError } from '../services/documentLifecycleCoordinator.mjs'

const SAFE_IDENTIFIER = /^[A-Za-z0-9-]+$/

function validIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export class AiReviewRevisionConflictError extends Error {
  constructor(currentRevision) {
    super('AI review workspace revision conflict')
    this.name = 'AiReviewRevisionConflictError'
    this.currentRevision = currentRevision
  }
}

export class FileBackedAiReviewRepository {
  constructor(storageRoot, {
    now = () => new Date(),
    lifecycleCoordinator = new DocumentLifecycleCoordinator(),
    documentExists = null,
  } = {}) {
    this.metadataRoot = path.resolve(storageRoot, 'metadata', 'ai-reviews')
    this.now = now
    this.lifecycleCoordinator = lifecycleCoordinator
    this.documentExists = documentExists
  }

  async init() {
    await ensureDirectory(this.metadataRoot)
  }

  documentDirectory(documentId) {
    if (!validIdentifier(documentId)) throw new Error('Invalid document identifier')
    const directory = path.resolve(this.metadataRoot, documentId)
    if (!isWithinRoot(this.metadataRoot, directory)) {
      throw new Error('AI review metadata path escapes root')
    }
    return directory
  }

  recordPath(documentId, chapterId) {
    if (!validIdentifier(chapterId)) throw new Error('Invalid chapter identifier')
    const documentDirectory = this.documentDirectory(documentId)
    const recordPath = path.resolve(documentDirectory, `${chapterId}.json`)
    if (!isWithinRoot(documentDirectory, recordPath)) {
      throw new Error('AI review metadata path escapes document scope')
    }
    return recordPath
  }

  async get(documentId, chapterId) {
    try {
      return await readJson(this.recordPath(documentId, chapterId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async listWorkspaces() {
    const workspaces = []
    const documents = await readdir(this.metadataRoot, { withFileTypes: true })
    for (const document of documents) {
      if (!document.isDirectory() || !validIdentifier(document.name)) continue
      const directory = this.documentDirectory(document.name)
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const chapterId = entry.name.slice(0, -5)
        if (!validIdentifier(chapterId)) continue
        const workspace = await this.get(document.name, chapterId)
        if (workspace) workspaces.push(workspace)
      }
    }
    return workspaces
  }

  async listRunningWorkspaces() {
    return (await this.listWorkspaces()).filter((workspace) => workspace.stage === 'ai_running')
  }

  async ensureDocumentExists(documentId) {
    if (this.documentExists && !(await this.documentExists(documentId))) {
      throw new DocumentNotFoundError(documentId)
    }
  }

  async save(documentId, chapterId, workspace, expectedRevision) {
    const recordPath = this.recordPath(documentId, chapterId)
    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      await this.ensureDocumentExists(documentId)
      const current = await this.get(documentId, chapterId)
      const currentRevision = current?.revision ?? 0
      if (expectedRevision !== currentRevision) {
        throw new AiReviewRevisionConflictError(currentRevision)
      }

      const timestamp = this.now().toISOString()
      const nextWorkspace = {
        schemaVersion: 1,
        documentId,
        chapterId,
        revision: currentRevision + 1,
        stage: workspace.stage,
        aiRun: structuredClone(workspace.aiRun),
        humanReview: structuredClone(workspace.humanReview),
        candidates: structuredClone(workspace.candidates),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      }
      await atomicWriteJson(recordPath, nextWorkspace)
      return nextWorkspace
    })
  }

  async removeDocumentFiles(documentId) {
    await rm(this.documentDirectory(documentId), { recursive: true, force: true })
  }
}
