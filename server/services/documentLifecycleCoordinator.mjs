export class DocumentNotFoundError extends Error {
  constructor(documentId) {
    super('Document not found: ' + documentId)
    this.name = 'DocumentNotFoundError'
    this.code = 'document_not_found'
  }
}

export class DocumentLifecycleCoordinator {
  constructor() {
    this.locks = new Map()
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
}
