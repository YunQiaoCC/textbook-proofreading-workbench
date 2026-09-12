/**
 * Framework- and infrastructure-independent document domain types.
 *
 * The original PDF is represented by an immutable asset. Derived assets are
 * also treated as immutable snapshots so regeneration creates a new asset.
 */

export type DocumentProcessingStatus =
  | 'registered'
  | 'uploaded'
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

export type PageTextSource = 'pdf_text' | 'ocr' | 'none'

export type PageTextStatus =
  | 'pending'
  | 'extracting'
  | 'ready'
  | 'ocr_required'
  | 'failed'

export type DocumentTextJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type TextQualityFlag =
  | 'empty_text'
  | 'too_little_text'
  | 'replacement_chars'
  | 'low_printable_ratio'
  | 'suspicious_glyphs'
  | 'usable_native_text'

export interface PageTextQuality {
  usable: boolean
  flags: TextQualityFlag[]
  charCount: number
  nonWhitespaceCharCount: number
  replacementCharacterCount: number
  printableRatio: number
  cjkCharCount: number
  cjkRatio: number
  lineCount: number
  wordCount: number
  textItemCount: number
  bboxCount: number
  controlCharacterRatio: number
  suspiciousGlyphRatio: number
}

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

export interface DocumentInspectionSummary {
  pageCount: number
  pagesWithText: number | null
  pagesWithoutText: number | null
  scannedPageRatio: number | null
  warningCount: number
  inspectedAt: string
}

export interface Document {
  id: string
  title: string
  originalAssetId: string
  pageCount: number
  processingStatus: DocumentProcessingStatus
  createdAt: string
  updatedAt: string
  inspectionSummary?: DocumentInspectionSummary
}

export interface Page {
  id: string
  documentId: string
  /** Physical PDF page number, one-based. */
  pdfPage: number
  /** Printed textbook page label; intentionally separate from pdfPage. */
  printedPage?: string
  chapterId?: string
  textSource?: PageTextSource
  textStatus?: PageTextStatus
  textCharCount?: number
  textQuality?: PageTextQuality
  textUpdatedAt?: string
}

export interface Chapter {
  id: string
  documentId: string
  title: string
  order: number
  startPdfPage: number
  endPdfPage: number
  assigneeName?: string
  status: ChapterStatus
  createdAt: string
  updatedAt: string
  /** Retained for compatibility with older chapter metadata. */
  level?: number
  parentChapterId?: string
}

export type ChapterStatus = 'unassigned' | 'not_started' | 'in_progress' | 'completed'

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
  | 'list'
  | 'other'

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfPointCoordinateSystem {
  unit: 'pt'
  origin: 'top-left'
  xAxis: 'right'
  yAxis: 'down'
  pageWidth: number
  pageHeight: number
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
  order: number
  type: TextBlockType
  text: string
  bbox?: BoundingBox
  source: Exclude<PageTextSource, 'none'>
  /** OCR-only confidence normalized to 0..1; absent for native PDF text. */
  confidence?: number
}

export interface PageTextArtifact {
  documentId: string
  /** Physical PDF page number, one-based. */
  pdfPage: number
  source: PageTextSource
  status: PageTextStatus
  charCount: number
  quality: PageTextQuality
  coordinateSystem: PdfPointCoordinateSystem | null
  blocks: PageTextBlock[]
  updatedAt: string
  errorMessage?: string
}

export interface DocumentTextJob {
  id: string
  documentId: string
  status: DocumentTextJobStatus
  totalPages: number
  processedPages: number
  nativeTextPages: number
  ocrRequiredPages: number
  failedPages: number
  createdAt: string
  startedAt?: string
  updatedAt: string
  completedAt?: string
  errorMessage?: string
  metrics?: {
    totalSeconds: number
    peakRssMb: number
  }
}

export interface ChapterTextBundle {
  documentId: string
  chapterId: string
  startPdfPage: number
  endPdfPage: number
  blocks: Array<Pick<PageTextBlock, 'pdfPage' | 'id' | 'type' | 'text' | 'source' | 'confidence'>>
}

export interface OcrPageInput {
  documentId: string
  pdfPage: number
  originalPdfPath: string
}

export interface OcrPageResult {
  documentId: string
  pdfPage: number
  blocks: PageTextBlock[]
}

export interface OcrProvider {
  processPage(input: OcrPageInput): Promise<OcrPageResult>
}
