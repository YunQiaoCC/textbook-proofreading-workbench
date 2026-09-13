import { HttpError } from './uploadSessionService.mjs'

const SAFE_DOCUMENT_ID = /^[A-Za-z0-9-]+$/

function notFound() {
  return new HttpError(404, 'document_not_found', 'document not found')
}

export class DocumentDeletionService {
  constructor({ documentRepository, proofreadingRepository, aiReviewRepository, textRepository, documentStorage, lifecycleCoordinator }) {
    this.documentRepository = documentRepository
    this.proofreadingRepository = proofreadingRepository
    this.aiReviewRepository = aiReviewRepository
    this.documentStorage = documentStorage
    this.textRepository = textRepository
    this.lifecycleCoordinator = lifecycleCoordinator
  }

  async delete(documentId) {
    if (typeof documentId !== 'string' || !SAFE_DOCUMENT_ID.test(documentId)) {
      throw notFound()
    }

    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      if (!(await this.documentRepository.getById(documentId))) {
        throw notFound()
      }
      await this.documentStorage.removeDocument(documentId)
      await this.proofreadingRepository.removeDocumentFiles(documentId)
      await this.aiReviewRepository.removeDocumentFiles(documentId)
      await this.textRepository.removeDocument(documentId)
      await this.documentRepository.removeDocumentRecord(documentId)
    })
  }
}
