export type PdfInspectionWarningSeverity = 'info' | 'warning' | 'error'

export interface PdfInspectionWarning {
  code: string
  message: string
  severity: PdfInspectionWarningSeverity
  pdfPage?: number
}

export interface PdfPageDimension {
  width: number | null
  height: number | null
  unit: 'pt'
}

export interface PdfInspectionPage {
  /** Physical PDF page number, one-based. */
  pdfPage: number
  width: number | null
  height: number | null
  rotation: number | null
  hasTextLayer: boolean | null
  textCharacterCount: number | null
  textItemCount: number | null
  suspicious: boolean | null
  warnings: readonly PdfInspectionWarning[]
}

export interface PdfTextLayerSummary {
  available: boolean
  method?: 'pdftotext'
  pagesWithText: number | null
  pagesWithoutText: number | null
  scannedPageRatio: number | null
  heuristic: string
}

export interface PdfInspectionReport {
  filePath: string
  fileName: string
  byteSize: number
  sha256: string
  pageCount: number | null
  pdfVersion?: string
  encrypted: boolean | null
  pageDimensions: readonly PdfPageDimension[]
  pages: readonly PdfInspectionPage[]
  textLayer: PdfTextLayerSummary
  warnings: readonly PdfInspectionWarning[]
  inspectedAt: string
}
