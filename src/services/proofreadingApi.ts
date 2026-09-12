import type { IAnnotationStore } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'
import { encodePathSegment, requestJson } from './apiClient'

export interface ServerProofreadingWorkspace {
  schemaVersion: number
  documentId: string
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

function proofreadingPath(documentId: string) {
  return `/documents/${encodePathSegment(documentId)}/proofreading`
}

export function getProofreadingWorkspace(documentId: string) {
  return requestJson<ServerProofreadingWorkspace>(proofreadingPath(documentId))
}

export function saveProofreadingWorkspace(
  documentId: string,
  payload: SaveProofreadingWorkspacePayload,
) {
  return requestJson<ServerProofreadingWorkspace>(proofreadingPath(documentId), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}
