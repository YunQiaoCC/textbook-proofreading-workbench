import type {
  Chapter,
  Document,
  DocumentAsset,
  Page,
} from '../models/document'

export interface DocumentRepository {
  getById(documentId: string): Promise<Document | null>
  listDocuments(): Promise<readonly Document[]>
  save(document: Document): Promise<void>
  saveAsset(asset: DocumentAsset): Promise<void>
  savePages(documentId: string, pages: readonly Page[]): Promise<void>
  listPages(documentId: string): Promise<readonly Page[]>
  listChapters(documentId: string): Promise<readonly Chapter[]>
  getChapter(documentId: string, chapterId: string): Promise<Chapter | null>
  saveChapter(documentId: string, chapter: Chapter): Promise<void>
  getAsset(assetId: string): Promise<DocumentAsset | null>
  getAssetForDocument(documentId: string, assetId: string): Promise<DocumentAsset | null>
}
