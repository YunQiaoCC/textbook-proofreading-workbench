import type { Annotation } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'

function getTextFromAnnotation(annotation: Annotation) {
  const payload = annotation.payload
  if (!payload) return ''
  if ('selectedText' in payload && typeof payload.selectedText === 'string') return payload.selectedText
  if ('text' in payload && typeof payload.text === 'string') return payload.text
  return ''
}

export function annotationToIssue(
  annotation: Annotation,
  reviewer: string,
  now = new Date().toISOString(),
): ProofreadingIssue {
  return {
    id: `issue-${annotation.id}`,
    annotationId: annotation.id,
    pdfPage: Math.max(1, (annotation.target?.pageIndex ?? 0) + 1),
    originalText: getTextFromAnnotation(annotation),
    category: 'other',
    suggestion: '',
    reason: '',
    status: 'pending',
    reviewer,
    createdAt: now,
    updatedAt: now,
  }
}

