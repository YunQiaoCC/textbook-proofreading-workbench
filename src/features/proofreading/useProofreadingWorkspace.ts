import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRef } from 'vue'
import { storeToAnnotation, type IAnnotationStore } from 'inklayer-vue'
import { ApiError } from '../../services/apiClient'
import {
  getChapterProofreadingWorkspace,
  saveChapterProofreadingWorkspace,
} from '../../services/proofreadingApi'
import type { ServerProofreadingWorkspace } from '../../services/proofreadingApi'
import {
  emptyWorkspace,
  loadProofreadingClientState,
  saveProofreadingClientState,
} from '../../services/proofreadingStorage'
import type { ProofreadingIssue, ProofreadingIssuePatch, IssueStatus } from '../../models/proofreading'
import { exportProofreadingCsv } from '../../services/proofreadingExport'
import {
  annotationToIssue,
  annotationValueToStore,
  type InkLayerAnnotationValue,
} from '../../utils/annotationAdapter'

const SAVE_DEBOUNCE_MS = 650

function formatSavedAt(timestamp = new Date().toISOString()) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function readableError(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return fallback
  if (error.code === 'network_error') return '网络错误，请检查连接'
  if (error.code === 'issue_outside_chapter_range') return '意见页码不在本章 PDF 范围内，请检查页码。'
  if (error.status === 409 || error.code === 'proofreading_revision_conflict') {
    return '检测到其他窗口中的更新，请重新加载最新校对数据。'
  }
  return fallback
}

export function useProofreadingWorkspace(
  defaultReviewer: string,
  documentId: MaybeRef<string | null>,
  chapterId: MaybeRef<string | null>,
  chapterStartPdfPage: MaybeRef<number | null>,
) {
  const annotations = ref<IAnnotationStore[]>([])
  const issues = ref<ProofreadingIssue[]>([])
  const selectedIssueId = ref<string | null>(null)
  const lastSavedAt = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const saveError = ref('')
  const revision = ref(0)
  const conflict = ref(false)
  const activeDocumentId = ref<string | null>(null)
  const activeChapterId = ref<string | null>(null)

  const selectedIssue = computed(() => issues.value.find((issue) => issue.id === selectedIssueId.value) ?? null)

  let loadGeneration = 0
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saveInFlight = false
  let saveInFlightPromise: Promise<void> | null = null
  let saveQueued = false
  let transitionFlushActive = false
  let transitionQueue: Promise<void> = Promise.resolve()

  function hasActiveScope() {
    return Boolean(activeDocumentId.value && activeChapterId.value)
  }

  function clearSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
  }

  function persistClientState() {
    const currentDocumentId = activeDocumentId.value
    const currentChapterId = activeChapterId.value
    if (!currentDocumentId || !currentChapterId) return
    saveProofreadingClientState(currentDocumentId, currentChapterId, {
      selectedIssueId: selectedIssueId.value,
      serverRevision: revision.value,
    })
  }

  function resetUiState() {
    annotations.value = [...emptyWorkspace.annotations]
    issues.value = [...emptyWorkspace.issues]
    selectedIssueId.value = null
    revision.value = 0
    lastSavedAt.value = ''
    saveError.value = ''
    conflict.value = false
  }

  function applyServerWorkspace(
    workspace: ServerProofreadingWorkspace,
    selectedPreference: string | null,
  ) {
    annotations.value = workspace.annotations
    issues.value = workspace.issues
    revision.value = workspace.revision
    selectedIssueId.value = selectedPreference && workspace.issues.some((issue) => issue.id === selectedPreference)
      ? selectedPreference
      : workspace.issues[0]?.id ?? null
    lastSavedAt.value = formatSavedAt(workspace.updatedAt)
    saveError.value = ''
    conflict.value = false
    persistClientState()
  }

  async function flushServerSave(generation: number) {
    saveTimer = null
    const currentDocumentId = activeDocumentId.value
    const currentChapterId = activeChapterId.value
    if (!currentDocumentId || !currentChapterId || conflict.value || loading.value) return
    if (saveInFlight) {
      saveQueued = true
      return
    }

    const snapshotAnnotations = annotations.value
    const snapshotIssues = issues.value
    const baseRevision = revision.value
    saveInFlight = true
    saving.value = true
    saveError.value = ''
    try {
      const savedWorkspace = await saveChapterProofreadingWorkspace(
        currentDocumentId,
        currentChapterId,
        { baseRevision, annotations: snapshotAnnotations, issues: snapshotIssues },
      )
      if (
        generation !== loadGeneration ||
        activeDocumentId.value !== currentDocumentId ||
        activeChapterId.value !== currentChapterId
      ) return

      if (annotations.value === snapshotAnnotations && issues.value === snapshotIssues) {
        annotations.value = savedWorkspace.annotations
        issues.value = savedWorkspace.issues
      }
      revision.value = savedWorkspace.revision
      lastSavedAt.value = formatSavedAt(savedWorkspace.updatedAt)
      conflict.value = false
      saveError.value = ''
      persistClientState()
    } catch (saveFailure) {
      if (
        generation !== loadGeneration ||
        activeDocumentId.value !== currentDocumentId ||
        activeChapterId.value !== currentChapterId
      ) return
      if (saveFailure instanceof ApiError && saveFailure.status === 409) {
        conflict.value = true
        saveError.value = readableError(saveFailure, '校对数据版本冲突')
        clearSaveTimer()
        saveQueued = false
      } else {
        saveError.value = readableError(saveFailure, '校对数据保存失败，请稍后重试')
        saveQueued = false
      }
    } finally {
      saveInFlight = false
      if (generation === loadGeneration && activeDocumentId.value === currentDocumentId && activeChapterId.value === currentChapterId) {
        saving.value = false
      }
      if (saveQueued && hasActiveScope() && !conflict.value && generation === loadGeneration && !transitionFlushActive) {
        saveQueued = false
        scheduleServerSave()
      }
    }
  }

  function startServerSave(generation: number) {
    const task = flushServerSave(generation)
    saveInFlightPromise = task
    void task.then(
      () => { if (saveInFlightPromise === task) saveInFlightPromise = null },
      () => { if (saveInFlightPromise === task) saveInFlightPromise = null },
    )
    return task
  }

  async function flushPendingSave() {
    transitionFlushActive = true
    try {
      while (true) {
        const hadPendingTimer = saveTimer !== null
        clearSaveTimer()
        if (hadPendingTimer) saveQueued = true
        if (saveInFlightPromise) {
          await saveInFlightPromise
          continue
        }
        if (saveQueued && hasActiveScope() && !conflict.value) {
          saveQueued = false
          await startServerSave(loadGeneration)
          continue
        }
        saveQueued = false
        return
      }
    } finally {
      transitionFlushActive = false
    }
  }

  function scheduleServerSave() {
    if (!hasActiveScope() || loading.value || conflict.value) return
    saveError.value = ''
    if (saveInFlight) {
      saveQueued = true
      return
    }
    clearSaveTimer()
    const generation = loadGeneration
    saveTimer = setTimeout(() => { void startServerSave(generation) }, SAVE_DEBOUNCE_MS)
  }

  async function loadWorkspace(nextDocumentId: string | null, nextChapterId: string | null) {
    // Wait for the old chapter before replacing shared UI state. Each save
    // captures its own documentId + chapterId, so it cannot land in a new one.
    await flushPendingSave()

    const generation = ++loadGeneration
    clearSaveTimer()
    saveQueued = false
    activeDocumentId.value = nextDocumentId
    activeChapterId.value = nextChapterId
    resetUiState()

    if (!nextDocumentId || !nextChapterId) {
      loading.value = false
      saving.value = false
      return
    }

    loading.value = true
    saving.value = false
    try {
      const serverWorkspace = await getChapterProofreadingWorkspace(nextDocumentId, nextChapterId)
      if (generation !== loadGeneration) return
      const clientState = loadProofreadingClientState(nextDocumentId, nextChapterId)
      applyServerWorkspace(serverWorkspace, clientState?.selectedIssueId ?? null)
    } catch (loadError) {
      if (generation !== loadGeneration) return
      saveError.value = readableError(loadError, '本章校对数据加载失败，请稍后重试')
      lastSavedAt.value = ''
    } finally {
      if (generation === loadGeneration) loading.value = false
    }
  }

  function selectIssue(id: string) {
    selectedIssueId.value = id
    persistClientState()
  }

  function createIssue(annotationId = `manual-${crypto.randomUUID()}`) {
    if (!hasActiveScope()) return
    const now = new Date().toISOString()
    const issue: ProofreadingIssue = {
      id: `issue-${annotationId}`,
      annotationId,
      pdfPage: toValue(chapterStartPdfPage) ?? 1,
      printedPage: '',
      originalText: '',
      category: 'other',
      suggestion: '',
      reason: '',
      status: 'pending',
      reviewer: defaultReviewer,
      verifier: '',
      createdAt: now,
      updatedAt: now,
    }
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistClientState()
    scheduleServerSave()
  }

  function addManualIssue() { createIssue() }

  function ensureIssueForAnnotation(annotationValue: InkLayerAnnotationValue) {
    if (!hasActiveScope()) return null
    const annotation = annotationValueToStore(annotationValue)
    const existing = issues.value.find((issue) => issue.annotationId === annotation.id)
    if (existing) {
      selectedIssueId.value = existing.id
      persistClientState()
      return existing
    }
    const issue = annotationToIssue(storeToAnnotation(annotation), defaultReviewer)
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistClientState()
    scheduleServerSave()
    return issue
  }

  function updateIssue(id: string, patch: ProofreadingIssuePatch) {
    issues.value = issues.value.map((issue) => issue.id === id
      ? { ...issue, ...patch, updatedAt: new Date().toISOString() }
      : issue)
    scheduleServerSave()
  }

  function updateIssueStatus(id: string, status: IssueStatus) { updateIssue(id, { status }) }

  function syncAnnotation(annotationValue: InkLayerAnnotationValue) {
    const annotation = annotationValueToStore(annotationValue)
    const index = annotations.value.findIndex((item) => item.id === annotation.id)
    annotations.value = index === -1
      ? [...annotations.value, annotation]
      : annotations.value.map((item) => item.id === annotation.id ? annotation : item)
    scheduleServerSave()
  }

  function handleAnnotationAdded(annotation: InkLayerAnnotationValue) {
    syncAnnotation(annotation)
    ensureIssueForAnnotation(annotation)
  }

  function handleAnnotationUpdated(annotation: InkLayerAnnotationValue) {
    syncAnnotation(annotation)
    ensureIssueForAnnotation(annotation)
  }

  function handleAnnotationDeleted(annotationId: string) {
    annotations.value = annotations.value.filter((annotation) => annotation.id !== annotationId)
    issues.value = issues.value.filter((issue) => issue.annotationId !== annotationId)
    if (!selectedIssue.value) {
      selectedIssueId.value = issues.value[0]?.id ?? null
      persistClientState()
    }
    scheduleServerSave()
  }

  function handleAnnotationSelected(annotation: InkLayerAnnotationValue | null) {
    if (annotation) ensureIssueForAnnotation(annotation)
  }

  function handleSave(nextAnnotations: InkLayerAnnotationValue[]) {
    annotations.value = nextAnnotations.map(annotationValueToStore)
    scheduleServerSave()
  }

  function reload() {
    return loadWorkspace(activeDocumentId.value, activeChapterId.value)
  }

  watch(
    () => [toValue(documentId), toValue(chapterId)] as const,
    ([nextDocumentId, nextChapterId]) => {
      transitionQueue = transitionQueue.then(() => loadWorkspace(nextDocumentId, nextChapterId))
      void transitionQueue.catch(() => undefined)
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    loadGeneration += 1
    clearSaveTimer()
    saveQueued = false
  })

  return {
    annotations,
    issues,
    selectedIssueId,
    selectedIssue,
    lastSavedAt,
    loading,
    saving,
    saveError,
    revision,
    conflict,
    addManualIssue,
    selectIssue,
    updateIssue,
    updateIssueStatus,
    handleAnnotationAdded,
    handleAnnotationDeleted,
    handleAnnotationSelected,
    handleAnnotationUpdated,
    handleSave,
    reload,
    exportIssues: () => exportProofreadingCsv(issues.value),
  }
}
