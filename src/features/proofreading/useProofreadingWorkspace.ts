import { computed, ref, toValue, watch, type MaybeRef } from 'vue'
import type { Annotation } from 'inklayer-vue'
import type { ProofreadingIssue, ProofreadingIssuePatch, IssueStatus } from '../../models/proofreading'
import {
  emptyWorkspace,
  loadProofreadingWorkspace,
  saveProofreadingWorkspace,
} from '../../services/proofreadingStorage'
import { exportProofreadingCsv } from '../../services/proofreadingExport'
import { annotationToIssue } from '../../utils/annotationAdapter'

export function useProofreadingWorkspace(defaultReviewer: string, documentId: MaybeRef<string | null>) {
  const annotations = ref<Annotation[]>([])
  const issues = ref<ProofreadingIssue[]>([])
  const selectedIssueId = ref<string | null>(null)
  const lastSavedAt = ref('')
  const activeDocumentId = ref<string | null>(null)

  const selectedIssue = computed(() => issues.value.find((issue) => issue.id === selectedIssueId.value) ?? null)

  function markSaved() {
    lastSavedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  function persistWorkspace() {
    if (!activeDocumentId.value) return
    saveProofreadingWorkspace(activeDocumentId.value, {
      annotations: annotations.value,
      issues: issues.value,
      selectedIssueId: selectedIssueId.value,
    })
    markSaved()
  }

  function loadWorkspace(nextDocumentId: string | null) {
    activeDocumentId.value = nextDocumentId
    if (!nextDocumentId) {
      annotations.value = [...emptyWorkspace.annotations]
      issues.value = [...emptyWorkspace.issues]
      selectedIssueId.value = emptyWorkspace.selectedIssueId
      lastSavedAt.value = ''
      return
    }
    const workspace = loadProofreadingWorkspace(nextDocumentId)
    annotations.value = workspace.annotations
    issues.value = workspace.issues
    selectedIssueId.value = workspace.selectedIssueId && workspace.issues.some((issue) => issue.id === workspace.selectedIssueId)
      ? workspace.selectedIssueId
      : workspace.issues[0]?.id ?? null
    lastSavedAt.value = ''
  }

  watch(() => toValue(documentId), loadWorkspace, { immediate: true })

  function selectIssue(id: string) {
    selectedIssueId.value = id
    persistWorkspace()
  }

  function createIssue(annotationId = `manual-${crypto.randomUUID()}`) {
    const now = new Date().toISOString()
    const issue: ProofreadingIssue = {
      id: `issue-${annotationId}`, annotationId, pdfPage: 1, printedPage: '', originalText: '',
      category: 'other', suggestion: '', reason: '', status: 'pending', reviewer: defaultReviewer,
      verifier: '', createdAt: now, updatedAt: now,
    }
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistWorkspace()
  }

  function addManualIssue() { createIssue() }

  function ensureIssueForAnnotation(annotation: Annotation) {
    const existing = issues.value.find((issue) => issue.annotationId === annotation.id)
    if (existing) { selectedIssueId.value = existing.id; persistWorkspace(); return existing }
    const issue = annotationToIssue(annotation, defaultReviewer)
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistWorkspace()
    return issue
  }

  function updateIssue(id: string, patch: ProofreadingIssuePatch) {
    issues.value = issues.value.map((issue) => issue.id === id ? { ...issue, ...patch, updatedAt: new Date().toISOString() } : issue)
    persistWorkspace()
  }

  function updateIssueStatus(id: string, status: IssueStatus) { updateIssue(id, { status }) }

  function syncAnnotation(annotation: Annotation) {
    const index = annotations.value.findIndex((item) => item.id === annotation.id)
    annotations.value = index === -1
      ? [...annotations.value, annotation]
      : annotations.value.map((item) => item.id === annotation.id ? annotation : item)
    persistWorkspace()
  }

  function handleAnnotationAdded(annotation: Annotation) { syncAnnotation(annotation); ensureIssueForAnnotation(annotation) }
  function handleAnnotationUpdated(annotation: Annotation) { syncAnnotation(annotation); ensureIssueForAnnotation(annotation) }

  function handleAnnotationDeleted(annotationId: string) {
    annotations.value = annotations.value.filter((annotation) => annotation.id !== annotationId)
    issues.value = issues.value.filter((issue) => issue.annotationId !== annotationId)
    if (!selectedIssue.value) selectedIssueId.value = issues.value[0]?.id ?? null
    persistWorkspace()
  }

  function handleAnnotationSelected(annotation: Annotation | null) {
    if (annotation) ensureIssueForAnnotation(annotation)
  }

  function handleSave(nextAnnotations: Annotation[]) { annotations.value = nextAnnotations; persistWorkspace() }

  return {
    annotations, issues, selectedIssueId, selectedIssue, lastSavedAt,
    addManualIssue, selectIssue, updateIssue, updateIssueStatus,
    handleAnnotationAdded, handleAnnotationDeleted, handleAnnotationSelected,
    handleAnnotationUpdated, handleSave,
    exportIssues: () => exportProofreadingCsv(issues.value),
  }
}
