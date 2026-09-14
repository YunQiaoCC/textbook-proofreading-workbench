import { HttpError } from './uploadSessionService.mjs'

const SAFE_IDENTIFIER = /^[A-Za-z0-9-]+$/

function notFound(code, message) {
  return new HttpError(404, code, message)
}

export class ChapterDeletionService {
  constructor({ documentRepository, aiReviewRepository, proofreadingRepository, lifecycleCoordinator }) {
    this.documentRepository = documentRepository
    this.aiReviewRepository = aiReviewRepository
    this.proofreadingRepository = proofreadingRepository
    this.lifecycleCoordinator = lifecycleCoordinator
  }

  async delete(documentId, chapterId) {
    if (typeof documentId !== 'string' || !SAFE_IDENTIFIER.test(documentId)) {
      throw notFound('document_not_found', 'document not found')
    }
    if (typeof chapterId !== 'string' || !SAFE_IDENTIFIER.test(chapterId)) {
      throw notFound('chapter_not_found', 'chapter not found')
    }

    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      if (!(await this.documentRepository.getById(documentId))) {
        throw notFound('document_not_found', 'document not found')
      }
      if (!(await this.documentRepository.getChapter(documentId, chapterId))) {
        throw notFound('chapter_not_found', 'chapter not found')
      }

      const aiWorkspace = await this.aiReviewRepository.get(documentId, chapterId)
      if (aiWorkspace?.stage === 'ai_running') {
        throw new HttpError(409, 'chapter_ai_running', 'cannot delete a chapter while its AI review is running')
      }

      await this.aiReviewRepository.removeChapterFiles(documentId, chapterId)
      await this.proofreadingRepository.removeChapterFiles(documentId, chapterId)
      await this.documentRepository.removeChapter(documentId, chapterId)
    })
  }
}
