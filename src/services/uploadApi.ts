import type { ApiDocument, ApiOriginalPdfAsset } from './documentApi'
import { encodePathSegment, requestJson } from './apiClient'

export const MAX_DOCUMENT_SIZE = 1024 * 1024 * 1024

export type UploadSessionStatus =
  | 'created'
  | 'uploading'
  | 'assembling'
  | 'completed'
  | 'failed'

export interface UploadSession {
  id: string
  originalFilename: string
  declaredByteSize: number
  chunkSize: number
  expectedParts: number
  receivedParts: number[]
  status: UploadSessionStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  documentId?: string
  errorMessage?: string
}

export interface CompleteUploadResponse {
  uploadSession: UploadSession
  document?: ApiDocument
  reusedExistingDocument: boolean
  asset?: ApiOriginalPdfAsset
  inspectionSummary?: ApiDocument['inspectionSummary']
  inspectionError?: string
}

function uploadPath(uploadId: string) {
  return `/uploads/${encodePathSegment(uploadId)}`
}

export function createUploadSession(file: File) {
  return requestJson<UploadSession>('/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      byteSize: file.size,
      mimeType: file.type || 'application/pdf',
    }),
  })
}

export function getUploadSession(uploadId: string) {
  return requestJson<UploadSession>(uploadPath(uploadId))
}

export function uploadPart(
  uploadId: string,
  partNumber: number,
  blob: Blob,
  signal?: AbortSignal,
) {
  return requestJson<UploadSession>(`${uploadPath(uploadId)}/parts/${partNumber}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
    signal,
  })
}

export function completeUpload(uploadId: string) {
  return requestJson<CompleteUploadResponse>(`${uploadPath(uploadId)}/complete`, {
    method: 'POST',
  })
}
