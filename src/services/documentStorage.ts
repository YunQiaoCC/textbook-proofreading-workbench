import type { DocumentAsset, OriginalPdfAsset } from '../models/document'

export interface OriginalPdfUpload {
  documentId: string
  byteSize: number
  sha256: string
  content: AsyncIterable<Uint8Array>
}

export interface DocumentStorage {
  storeOriginalPdf(input: OriginalPdfUpload): Promise<OriginalPdfAsset>
  read(asset: DocumentAsset): Promise<AsyncIterable<Uint8Array>>
}
