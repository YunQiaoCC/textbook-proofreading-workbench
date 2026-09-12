import type { IAnnotationStore } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'
import { encodePathSegment, requestJson } from './apiClient'

export interface ServerProofreadingWorkspace {
  schemaVersion: number
  documentId: string
  /** Present for chapter-scoped workspaces; omitted by the legacy endpoint. */
  chapterId?: string
  revision: number
  annotations: IAnnotationStore[]
  issues: ProofreadingIssue[]
  createdAt: string
  updatedAt: string
}

export interface SaveProofreadingWorkspacePayload {
  baseRevision: number
  annotations: IAnnotationStore[]
  issues: ProofreadingIssue[]
}

function proofreadingPath(documentId: string, chapterId?: string) {
  if (chapterId) {
    return `/documents/${encodePathSegment(documentId)}/chapters/${encodePathSegment(chapterId)}/proofreading`
  }
  // Legacy/document-scope compatibility endpoint.
  return `/documents/${encodePathSegment(documentId)}/proofreading`
}

export function getProofreadingWorkspace(documentId: string, chapterId?: string) {
  return requestJson<ServerProofreadingWorkspace>(proofreadingPath(documentId, chapterId))
}

export function getChapterProofreadingWorkspace(documentId: string, chapterId: string) {
  return getProofreadingWorkspace(documentId, chapterId)
}

export function saveProofreadingWorkspace(
  documentId: string,
  payload: SaveProofreadingWorkspacePayload,
  chapterId?: string,
) {
  return requestJson<ServerProofreadingWorkspace>(proofreadingPath(documentId, chapterId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function saveChapterProofreadingWorkspace(
  documentId: string,
  chapterId: string,
  payload: SaveProofreadingWorkspacePayload,
) {
  return saveProofreadingWorkspace(documentId, payload, chapterId)
}
