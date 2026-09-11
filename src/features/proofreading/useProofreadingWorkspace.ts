import { computed, ref } from 'vue'
import type { Annotation } from 'inklayer-vue'
import type { ProofreadingIssue, ProofreadingIssuePatch, IssueStatus } from '../../models/proofreading'
import { loadAnnotations, loadProofreadingIssues, saveAnnotations, saveProofreadingIssues } from '../../services/proofreadingStorage'
import { exportProofreadingCsv } from '../../services/proofreadingExport'
import { annotationToIssue } from '../../utils/annotationAdapter'

export function useProofreadingWorkspace(defaultReviewer: string) {
  const annotations = ref<Annotation[]>(loadAnnotations())
  const issues = ref<ProofreadingIssue[]>(loadProofreadingIssues())
  const selectedIssueId = ref<string | null>(issues.value[0]?.id ?? null)
  const lastSavedAt = ref('')

  const selectedIssue = computed(() => issues.value.find((issue) => issue.id === selectedIssueId.value) ?? null)

  function markSaved() {
    lastSavedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  function persistIssues() { saveProofreadingIssues(issues.value); markSaved() }
  function persistAnnotations() { saveAnnotations(annotations.value); markSaved() }
  function selectIssue(id: string) { selectedIssueId.value = id }

  function createIssue(annotationId = `manual-${crypto.randomUUID()}`) {
    const now = new Date().toISOString()
    const issue: ProofreadingIssue = {
      id: `issue-${annotationId}`, annotationId, pdfPage: 1, printedPage: '', originalText: '',
      category: 'other', suggestion: '', reason: '', status: 'pending', reviewer: defaultReviewer,
      verifier: '', createdAt: now, updatedAt: now,
    }
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistIssues()
  }

  function addManualIssue() { createIssue() }

  function ensureIssueForAnnotation(annotation: Annotation) {
    const existing = issues.value.find((issue) => issue.annotationId === annotation.id)
    if (existing) { selectedIssueId.value = existing.id; return existing }
    const issue = annotationToIssue(annotation, defaultReviewer)
    issues.value = [issue, ...issues.value]
    selectedIssueId.value = issue.id
    persistIssues()
    return issue
  }

  function updateIssue(id: string, patch: ProofreadingIssuePatch) {
    issues.value = issues.value.map((issue) => issue.id === id ? { ...issue, ...patch, updatedAt: new Date().toISOString() } : issue)
    persistIssues()
  }

  function updateIssueStatus(id: string, status: IssueStatus) { updateIssue(id, { status }) }

  function syncAnnotation(annotation: Annotation) {
    const index = annotations.value.findIndex((item) => item.id === annotation.id)
    annotations.value = index === -1
      ? [...annotations.value, annotation]
      : annotations.value.map((item) => item.id === annotation.id ? annotation : item)
    persistAnnotations()
  }

  function handleAnnotationAdded(annotation: Annotation) { syncAnnotation(annotation); ensureIssueForAnnotation(annotation) }
  function handleAnnotationUpdated(annotation: Annotation) { syncAnnotation(annotation); ensureIssueForAnnotation(annotation) }

  function handleAnnotationDeleted(annotationId: string) {
    annotations.value = annotations.value.filter((annotation) => annotation.id !== annotationId)
    issues.value = issues.value.filter((issue) => issue.annotationId !== annotationId)
    if (!selectedIssue.value) selectedIssueId.value = issues.value[0]?.id ?? null
    persistAnnotations(); persistIssues()
  }

  function handleAnnotationSelected(annotation: Annotation | null) {
    if (annotation) ensureIssueForAnnotation(annotation)
  }

  function handleSave(nextAnnotations: Annotation[]) { annotations.value = nextAnnotations; persistAnnotations() }

  return {
    annotations, issues, selectedIssueId, selectedIssue, lastSavedAt,
    addManualIssue, selectIssue, updateIssue, updateIssueStatus,
    handleAnnotationAdded, handleAnnotationDeleted, handleAnnotationSelected,
    handleAnnotationUpdated, handleSave,
    exportIssues: () => exportProofreadingCsv(issues.value),
  }
}

