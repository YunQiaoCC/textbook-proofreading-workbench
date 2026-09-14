import type {
  AiCandidateResolutionStatus,
  AiReviewSummary,
  AiReviewWorkspace,
  AiRuntimeStatus,
  ModifiedCandidateResult,
} from '../models/aiReview'
import { encodePathSegment, requestJson } from './apiClient'

function documentPath(documentId: string) {
  return `/documents/${encodePathSegment(documentId)}`
}

export function getAiRuntimeStatus() {
  return requestJson<AiRuntimeStatus>('/ai-runtime/status')
}

export function runAiReview(documentId: string, chapterId: string, baseRevision: number) {
  return requestJson<AiReviewWorkspace>(`${reviewPath(documentId, chapterId)}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision }),
  })
}

function reviewPath(documentId: string, chapterId: string) {
  return `${documentPath(documentId)}/chapters/${encodePathSegment(chapterId)}/ai-review`
}

export function getAiReviewWorkspace(documentId: string, chapterId: string) {
  return requestJson<AiReviewWorkspace>(reviewPath(documentId, chapterId))
}

export function getAiReviewSummaries(documentId: string) {
  return requestJson<{ documentId: string; reviews: AiReviewSummary[] }>(`${documentPath(documentId)}/ai-reviews`)
}

export function startHumanReview(documentId: string, chapterId: string, reviewerName: string, baseRevision: number) {
  return requestJson<AiReviewWorkspace>(`${reviewPath(documentId, chapterId)}/human-review/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewerName, baseRevision }),
  })
}

export function resolveAiCandidate(
  documentId: string,
  chapterId: string,
  candidateId: string,
  resolution: { status: Exclude<AiCandidateResolutionStatus, 'pending'>; resolvedBy: string; modifiedResult?: ModifiedCandidateResult },
  baseRevision: number,
) {
  return requestJson<AiReviewWorkspace>(`${reviewPath(documentId, chapterId)}/candidates/${encodePathSegment(candidateId)}/resolution`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...resolution, baseRevision }),
  })
}

export function completeHumanReview(documentId: string, chapterId: string, reviewerName: string, baseRevision: number) {
  return requestJson<AiReviewWorkspace>(`${reviewPath(documentId, chapterId)}/human-review/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewerName, baseRevision }),
  })
}

export function rollbackAiReview(
  documentId: string,
  chapterId: string,
  targetStage: 'human_review_in_progress' | 'awaiting_human_review',
  reviewerName: string,
  baseRevision: number,
) {
  return requestJson<AiReviewWorkspace>(`${reviewPath(documentId, chapterId)}/rollback`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetStage, reviewerName, baseRevision }),
  })
}
