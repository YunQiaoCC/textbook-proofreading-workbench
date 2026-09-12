import { computed, onUnmounted, ref } from 'vue'
import type { Chapter, DocumentTextJob, Page } from '../../models/document'
import { ApiError } from '../../services/apiClient'
import { clearProofreadingClientState } from '../../services/proofreadingStorage'
import {
  getDocument,
  getDocumentPages,
  getDocumentTextStatus,
  startDocumentTextExtraction,
  deleteDocument as deleteDocumentRequest,
  createChapter,
  listChapters,
  listDocuments,
  updateChapter,
  type ChapterInput,
  type ApiDocument,
} from '../../services/documentApi'

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 60_000

function isProcessing(document: ApiDocument) {
  return document.processingStatus === 'uploaded' || document.processingStatus === 'inspecting'
}

function readableError(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return fallback
  if (error.code === 'network_error') return '网络错误，请检查连接'
  if (error.code === 'document_not_found') return '文档不存在或已被移除'
  return fallback
}

export function useDocumentWorkspace() {
  const documents = ref<ApiDocument[]>([])
  const selectedDocumentId = ref<string | null>(null)
  const pages = ref<Page[]>([])
  const chapters = ref<Chapter[]>([])
  const selectedChapterId = ref<string | null>(null)
  const loading = ref(false)
  const chapterLoading = ref(false)
  const error = ref('')
  const chapterError = ref('')
  const deletingDocumentId = ref<string | null>(null)
  const deleteError = ref('')
  const textSummary = ref<DocumentTextJob | null>(null)
  const textError = ref('')
  const selectedDocument = computed(() =>
    documents.value.find((document) => document.id === selectedDocumentId.value) ?? null,
  )
  const selectedChapter = computed(() =>
    chapters.value.find((chapter) => chapter.id === selectedChapterId.value) ?? null,
  )

  let operationId = 0
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let textPollTimer: ReturnType<typeof setTimeout> | null = null
  let pollingDocumentId: string | null = null
  let pollingDeadline = 0

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
    pollingDocumentId = null
    pollingDeadline = 0
  }

  function stopTextPolling() {
    if (textPollTimer) clearTimeout(textPollTimer)
    textPollTimer = null
  }

  async function refreshTextStatus(documentId: string) {
    try {
      const summary = await getDocumentTextStatus(documentId)
      if (selectedDocumentId.value !== documentId) return
      textSummary.value = summary
      textError.value = ''
      if (summary && ['queued', 'processing'].includes(summary.status)) {
        stopTextPolling()
        textPollTimer = setTimeout(() => { void refreshTextStatus(documentId) }, POLL_INTERVAL_MS)
      }
    } catch (requestError) {
      if (selectedDocumentId.value === documentId) {
        textError.value = readableError(requestError, '文本状态读取失败')
      }
    }
  }

  async function restartTextExtraction() {
    const documentId = selectedDocumentId.value
    if (!documentId) return
    textError.value = ''
    try {
      textSummary.value = await startDocumentTextExtraction(documentId)
      void refreshTextStatus(documentId)
    } catch (requestError) {
      textError.value = readableError(requestError, '文本重新解析启动失败')
    }
  }

  function replaceDocument(document: ApiDocument) {
    const index = documents.value.findIndex((item) => item.id === document.id)
    documents.value = index === -1
      ? [...documents.value, document]
      : documents.value.map((item, itemIndex) => itemIndex === index ? document : item)
  }

  function schedulePolling(documentId: string) {
    stopPolling()
    pollingDocumentId = documentId
    pollingDeadline = Date.now() + POLL_TIMEOUT_MS

    const poll = async () => {
      if (pollingDocumentId !== documentId || selectedDocumentId.value !== documentId) return
      const latest = await refreshDocument(documentId, { silent: true, schedulePolling: false })
      if (
        latest &&
        isProcessing(latest) &&
        Date.now() < pollingDeadline &&
        pollingDocumentId === documentId
      ) {
        pollTimer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
        return
      }
      if (latest?.processingStatus === 'failed') error.value = 'inspection failed，请检查 PDF 后重试'
      if (latest?.processingStatus === 'ready') void refreshTextStatus(documentId)
      stopPolling()
    }

    pollTimer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
  }

  async function refreshDocument(
    documentId: string,
    options: { silent?: boolean; schedulePolling?: boolean } = {},
  ) {
    const requestOperationId = operationId
    try {
      const detail = await getDocument(documentId)
      if (requestOperationId !== operationId) return null
      replaceDocument(detail.document)
      if (
        options.schedulePolling !== false &&
        selectedDocumentId.value === documentId &&
        isProcessing(detail.document)
      ) schedulePolling(documentId)
      return detail.document
    } catch (requestError) {
      if (!options.silent && requestOperationId === operationId) {
        error.value = readableError(requestError, '文档状态刷新失败')
      }
      return null
    }
  }

  async function selectDocument(documentId: string) {
    const requestOperationId = ++operationId
    stopPolling()
    selectedDocumentId.value = documentId
    stopTextPolling()
    textSummary.value = null
    textError.value = ''
    pages.value = []
    chapters.value = []
    selectedChapterId.value = null
    chapterError.value = ''
    chapterLoading.value = true
    loading.value = true
    error.value = ''
    try {
      const detail = await getDocument(documentId)
      if (requestOperationId !== operationId) return
      replaceDocument(detail.document)

      const [pageResponse, chapterResponse] = await Promise.all([
        getDocumentPages(documentId),
        listChapters(documentId),
      ])
      if (requestOperationId !== operationId) return
      pages.value = pageResponse.pages
      chapters.value = chapterResponse.chapters
      selectedChapterId.value = chapterResponse.chapters[0]?.id ?? null
      void refreshTextStatus(documentId)
      if (isProcessing(detail.document)) schedulePolling(documentId)
    } catch (requestError) {
      if (requestOperationId === operationId) {
        error.value = readableError(requestError, '文档加载失败，请稍后重试')
      }
    } finally {
      if (requestOperationId === operationId) chapterLoading.value = false
      if (requestOperationId === operationId) loading.value = false
    }
  }

  function selectChapter(chapterId: string) {
    if (chapters.value.some((chapter) => chapter.id === chapterId)) {
      selectedChapterId.value = chapterId
      chapterError.value = ''
    }
  }

  async function createDocumentChapter(payload: ChapterInput): Promise<Chapter | null> {
    const documentId = selectedDocumentId.value
    if (!documentId) return null
    chapterLoading.value = true
    chapterError.value = ''
    try {
      const chapter = await createChapter(documentId, payload)
      chapters.value = [...chapters.value, chapter].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      selectedChapterId.value = chapter.id
      return chapter
    } catch (chapterCreateError) {
      chapterError.value = readableError(chapterCreateError, '章节保存失败，请检查页码和填写内容')
      return null
    } finally {
      chapterLoading.value = false
    }
  }

  async function updateDocumentChapter(chapterId: string, payload: ChapterInput): Promise<Chapter | null> {
    const documentId = selectedDocumentId.value
    if (!documentId) return null
    chapterLoading.value = true
    chapterError.value = ''
    try {
      const chapter = await updateChapter(documentId, chapterId, payload)
      chapters.value = chapters.value
        .map((item) => item.id === chapter.id ? chapter : item)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      return chapter
    } catch (chapterUpdateError) {
      chapterError.value = readableError(chapterUpdateError, '章节更新失败，请检查页码和填写内容')
      return null
    } finally {
      chapterLoading.value = false
    }
  }

  async function deleteDocumentById(documentId: string) {
    if (deletingDocumentId.value) return false
    deletingDocumentId.value = documentId
    deleteError.value = ''
    stopPolling()
    try {
      await deleteDocumentRequest(documentId)
      clearProofreadingClientState(documentId)
      const removedIndex = documents.value.findIndex((document) => document.id === documentId)
      const remaining = documents.value.filter((document) => document.id !== documentId)
      documents.value = remaining

      if (selectedDocumentId.value === documentId) {
        selectedDocumentId.value = null
        stopTextPolling()
        textSummary.value = null
        pages.value = []
        chapters.value = []
        selectedChapterId.value = null
        chapterLoading.value = false
        loading.value = false
        const nextDocument = remaining[removedIndex] ?? remaining[removedIndex - 1] ?? null
        if (nextDocument) await selectDocument(nextDocument.id)
      }
      return true
    } catch (deleteFailure) {
      deleteError.value = readableError(deleteFailure, 'document deletion failed; please try again')
      return false
    } finally {
      deletingDocumentId.value = null
    }
  }

  async function loadDocuments(preferredDocumentId?: string) {
    const requestOperationId = ++operationId
    stopPolling()
    loading.value = true
    error.value = ''
    try {
      const response = await listDocuments()
      if (requestOperationId !== operationId) return
      documents.value = response.documents
      const preferred = preferredDocumentId && response.documents.some((document) => document.id === preferredDocumentId)
        ? preferredDocumentId
        : selectedDocumentId.value && response.documents.some((document) => document.id === selectedDocumentId.value)
          ? selectedDocumentId.value
          : response.documents[0]?.id

      if (!preferred) {
        selectedDocumentId.value = null
        stopTextPolling()
        textSummary.value = null
        textError.value = ''
        pages.value = []
        chapters.value = []
        selectedChapterId.value = null
        chapterLoading.value = false
        loading.value = false
        return
      }
      await selectDocument(preferred)
    } catch (requestError) {
      if (requestOperationId === operationId) {
        error.value = readableError(requestError, '文档列表加载失败，请稍后重试')
        loading.value = false
      }
    }
  }

  onUnmounted(() => {
    stopPolling()
    stopTextPolling()
  })

  return {
    documents,
    selectedDocumentId,
    selectedDocument,
    chapters,
    selectedChapterId,
    selectedChapter,
    pages,
    loading,
    chapterLoading,
    error,
    chapterError,
    deletingDocumentId,
    deleteError,
    textSummary,
    textError,
    restartTextExtraction,
    loadDocuments,
    selectDocument,
    selectChapter,
    createChapter: createDocumentChapter,
    updateChapter: updateDocumentChapter,
    refreshDocument,
    deleteDocumentById,
  }
}
