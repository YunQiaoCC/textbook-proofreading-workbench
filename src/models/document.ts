/**
 * Framework- and infrastructure-independent document domain types.
 *
 * The original PDF is represented by an immutable asset. Derived assets are
 * also treated as immutable snapshots so regeneration creates a new asset.
 */

export type DocumentProcessingStatus =
  | 'registered'
  | 'inspecting'
  | 'ready'
  | 'processing'
  | 'failed'

export type OcrJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type OcrEngine = 'paddleocr' | 'ocrmypdf' | 'tesseract' | 'manual'

export type DocumentAssetKind =
  | 'original-pdf'
  | 'searchable-pdf'
  | 'page-preview'

export interface DocumentAssetBase {
  id: string
  documentId: string
  kind: DocumentAssetKind
  storageKey: string
  mediaType: string
  byteSize: number
  sha256: string
  createdAt: string
  immutable: true
}

export interface OriginalPdfAsset extends DocumentAssetBase {
  kind: 'original-pdf'
  mediaType: 'application/pdf'
}

export interface DerivedDocumentAsset extends DocumentAssetBase {
  kind: 'searchable-pdf' | 'page-preview'
  sourceAssetId?: string
}

export type DocumentAsset = OriginalPdfAsset | DerivedDocumentAsset

export interface Document {
  id: string
  title: string
  originalAssetId: string
  pageCount: number
  processingStatus: DocumentProcessingStatus
  createdAt: string
  updatedAt: string
}

export interface Page {
  id: string
  documentId: string
  /** Physical PDF page number, one-based. */
  pdfPage: number
  /** Printed textbook page label; intentionally separate from pdfPage. */
  printedPage?: string
  chapterId?: string
}

export interface Chapter {
  id: string
  documentId: string
  title: string
  level: number
  order: number
  startPdfPage: number
  endPdfPage?: number
  parentChapterId?: string
}

export interface OcrPageRange {
  startPdfPage: number
  endPdfPage: number
}

export interface OcrJob {
  id: string
  documentId: string
  sourceAssetId: string
  status: OcrJobStatus
  engine: OcrEngine
  modelVersion: string
  requestedAt: string
  startedAt?: string
  completedAt?: string
  pageRange?: OcrPageRange
  errorMessage?: string
}

export type TextBlockType =
  | 'paragraph'
  | 'heading'
  | 'footnote'
  | 'table'
  | 'caption'
  | 'header'
  | 'footer'
  | 'list-item'
  | 'unknown'

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PolygonPoint {
  x: number
  y: number
}

export interface PageTextBlock {
  id: string
  documentId: string
  /** Physical PDF page number, one-based. */
  pdfPage: number
  text: string
  normalizedText: string
  blockType: TextBlockType
  readingOrder: number
  /** OCR confidence normalized to the inclusive range 0..1. */
  confidence: number
  bbox: BoundingBox
  polygon?: readonly PolygonPoint[]
  engine: OcrEngine
  modelVersion: string
}
