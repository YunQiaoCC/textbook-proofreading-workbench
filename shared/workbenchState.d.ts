import type { AiReviewStage, AiReviewWorkspace } from '../src/models/aiReview'
import type { Chapter } from '../src/models/document'
import type { ServerProofreadingWorkspace } from '../src/services/proofreadingApi'

export function isAnnotationReadOnly(stage: AiReviewStage | null | undefined): boolean
export function annotationEditingEnabled(stage: AiReviewStage | null | undefined, hasSelectedChapter: boolean): boolean
export function nextSelectedChapterId(
  chapters: readonly Pick<Chapter, 'id'>[],
  selectedChapterId: string | null,
  deletedChapterId: string,
): string | null
export function chapterHasWork(
  chapter: Chapter | null | undefined,
  aiWorkspace: AiReviewWorkspace | null | undefined,
  proofreadingWorkspace: ServerProofreadingWorkspace | null | undefined,
): boolean
export function proofreadingClientStorageKey(documentId: string, chapterId: string): string
export function clearProofreadingClientStateFromStorage(
  storage: Pick<Storage, 'removeItem'>,
  documentId: string,
  chapterId?: string,
): void
