import type {
  Chapter,
  Document,
  DocumentInspectionSummary,
  DocumentTextJob,
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

export type ApiChapter = Chapter

export interface ChapterListResponse {
  documentId: string
  chapters: ApiChapter[]
}

export interface ChapterInput {
  title: string
  order: number
  startPdfPage: number
  endPdfPage: number
  assigneeName?: string
  status: Chapter['status']
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

function chaptersPath(documentId: string) {
  return `${documentPath(documentId)}/chapters`
}

export function listChapters(documentId: string) {
  return requestJson<ChapterListResponse>(chaptersPath(documentId))
}

export function createChapter(documentId: string, payload: ChapterInput) {
  return requestJson<ApiChapter>(chaptersPath(documentId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function updateChapter(documentId: string, chapterId: string, payload: ChapterInput) {
  return requestJson<ApiChapter>(`${chaptersPath(documentId)}/${encodePathSegment(chapterId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function deleteDocument(documentId: string) {
  return requestJson<void>(documentPath(documentId), { method: 'DELETE' })
}

export function startDocumentTextExtraction(documentId: string) {
  return requestJson<DocumentTextJob>(`${documentPath(documentId)}/text/extract`, { method: 'POST' })
}

export function getDocumentTextStatus(documentId: string) {
  return requestJson<DocumentTextJob | null>(`${documentPath(documentId)}/text/status`)
}

export function documentFileUrl(documentId: string) {
  return apiPath(`${documentPath(documentId)}/file`)
}
