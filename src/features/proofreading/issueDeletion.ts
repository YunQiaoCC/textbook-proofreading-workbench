import type { IAnnotationStore } from 'inklayer-vue'
import type { ProofreadingIssue } from '../../models/proofreading'

export interface IssueDeletionSnapshot {
  issues: ProofreadingIssue[]
  annotations: IAnnotationStore[]
  selectedIssueId: string | null
  linkedAnnotationId: string | null
  deleted: boolean
}

export function deleteIssueSnapshot(
  issues: ProofreadingIssue[],
  annotations: IAnnotationStore[],
  selectedIssueId: string | null,
  issueId: string,
): IssueDeletionSnapshot {
  const deletedIndex = issues.findIndex((issue) => issue.id === issueId)
  if (deletedIndex === -1) {
    return { issues, annotations, selectedIssueId, linkedAnnotationId: null, deleted: false }
  }

  const issue = issues[deletedIndex]
  const linkedAnnotationId = annotations.some((annotation) => annotation.id === issue.annotationId)
    ? issue.annotationId
    : null
  const nextIssues = issues.filter((item) => item.id !== issueId)
  const nextAnnotations = linkedAnnotationId
    ? annotations.filter((annotation) => annotation.id !== linkedAnnotationId)
    : annotations
  let nextSelectedIssueId = selectedIssueId
  if (selectedIssueId === issueId || !nextIssues.some((item) => item.id === selectedIssueId)) {
    nextSelectedIssueId = nextIssues[deletedIndex]?.id ?? nextIssues[deletedIndex - 1]?.id ?? null
  }

  return {
    issues: nextIssues,
    annotations: nextAnnotations,
    selectedIssueId: nextSelectedIssueId,
    linkedAnnotationId,
    deleted: true,
  }
}
