import type {
  Chapter,
  Document,
  DocumentAsset,
  Page,
} from '../models/document'

export interface DocumentRepository {
  getById(documentId: string): Promise<Document | null>
  save(document: Document): Promise<void>
  saveAsset(asset: DocumentAsset): Promise<void>
  savePages(documentId: string, pages: readonly Page[]): Promise<void>
  listPages(documentId: string): Promise<readonly Page[]>
  listChapters(documentId: string): Promise<readonly Chapter[]>
  getAsset(assetId: string): Promise<DocumentAsset | null>
}
