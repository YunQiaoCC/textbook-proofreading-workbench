import {
  annotationToStore as coreAnnotationToStore,
  storeToAnnotation,
  type Annotation,
  type IAnnotationStore,
} from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'

export type InkLayerAnnotationValue = Annotation | IAnnotationStore

export function isAnnotationStore(value: InkLayerAnnotationValue): value is IAnnotationStore {
  return 'konvaString' in value && 'konvaClientRect' in value && 'pageNumber' in value
}

export function annotationValueToStore(value: InkLayerAnnotationValue): IAnnotationStore {
  return isAnnotationStore(value) ? value : coreAnnotationToStore(value)
}

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

export function annotationStoresToCore(stores: readonly IAnnotationStore[]): Annotation[] {
  const result: Annotation[] = []
  for (const store of stores) {
    try {
      result.push(storeToAnnotation(store))
    } catch {
      // Keep the review list usable if an older/incomplete annotation cannot be rendered by InkLayer.
    }
  }
  return result
}
