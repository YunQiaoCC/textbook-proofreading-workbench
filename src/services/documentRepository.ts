import type {
  Chapter,
  Document,
  DocumentAsset,
  Page,
} from '../models/document'

export interface DocumentRepository {
  getById(documentId: string): Promise<Document | null>
  save(document: Document): Promise<void>
  listPages(documentId: string): Promise<readonly Page[]>
  listChapters(documentId: string): Promise<readonly Chapter[]>
  getAsset(assetId: string): Promise<DocumentAsset | null>
}
