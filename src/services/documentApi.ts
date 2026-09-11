import type {
  Document,
  DocumentInspectionSummary,
  OriginalPdfAsset,
  Page,
} from '../models/document'
import { apiPath, encodePathSegment, requestJson } from './apiClient'

export type ApiDocument = Omit<Document, 'inspectionSummary'> & {
  inspectionSummary: DocumentInspectionSummary | null
}

export type ApiOriginalPdfAsset = Omit<OriginalPdfAsset, 'storageKey'>

export interface DocumentListResponse {
  documents: ApiDocument[]
}

export interface DocumentDetailResponse {
  document: ApiDocument
  asset: ApiOriginalPdfAsset
  inspectionSummary: DocumentInspectionSummary | null
}

export interface DocumentPagesResponse {
  documentId: string
  pages: Page[]
}

function documentPath(documentId: string) {
  return `/documents/${encodePathSegment(documentId)}`
}

export function listDocuments() {
  return requestJson<DocumentListResponse>('/documents')
}

export function getDocument(documentId: string) {
  return requestJson<DocumentDetailResponse>(documentPath(documentId))
}

export function getDocumentPages(documentId: string) {
  return requestJson<DocumentPagesResponse>(`${documentPath(documentId)}/pages`)
}

export function documentFileUrl(documentId: string) {
  return apiPath(`${documentPath(documentId)}/file`)
}
