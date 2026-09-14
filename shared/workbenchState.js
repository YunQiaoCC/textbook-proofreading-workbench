export function isAnnotationReadOnly(stage) {
  return stage === 'completed'
}

export function annotationEditingEnabled(stage, hasSelectedChapter) {
  return Boolean(hasSelectedChapter) && !isAnnotationReadOnly(stage)
}

export function nextSelectedChapterId(chapters, selectedChapterId, deletedChapterId) {
  const deletedIndex = chapters.findIndex((chapter) => chapter.id === deletedChapterId)
  const remaining = chapters.filter((chapter) => chapter.id !== deletedChapterId)
  if (selectedChapterId !== deletedChapterId) {
    return remaining.some((chapter) => chapter.id === selectedChapterId) ? selectedChapterId : remaining[0]?.id ?? null
  }
  return remaining[deletedIndex]?.id ?? remaining[deletedIndex - 1]?.id ?? null
}

export function chapterHasWork(chapter, aiWorkspace, proofreadingWorkspace) {
  return Boolean(
    ['in_progress', 'completed'].includes(chapter?.status) ||
    aiWorkspace && (
      aiWorkspace.revision > 0 ||
      aiWorkspace.stage !== 'awaiting_ai' ||
      aiWorkspace.aiRun?.status !== 'not_started' ||
      aiWorkspace.humanReview?.status !== 'not_started' ||
      aiWorkspace.candidates?.length > 0
    ) ||
    proofreadingWorkspace && (
      proofreadingWorkspace.revision > 0 ||
      proofreadingWorkspace.annotations?.length > 0 ||
      proofreadingWorkspace.issues?.length > 0
    ),
  )
}

function encodedDocumentId(documentId) {
  return encodeURIComponent(documentId)
}

export function proofreadingClientStorageKey(documentId, chapterId) {
  return `proofreading-client:v3:${encodedDocumentId(documentId)}:${encodedDocumentId(chapterId)}`
}

export function clearProofreadingClientStateFromStorage(storage, documentId, chapterId) {
  if (chapterId) {
    storage.removeItem(proofreadingClientStorageKey(documentId, chapterId))
    return
  }
  const prefix = `proofreading-client:v3:${encodedDocumentId(documentId)}:`
  for (const key of Object.keys(storage)) {
    if (key.startsWith(prefix)) storage.removeItem(key)
  }
}
