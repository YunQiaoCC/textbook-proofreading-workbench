import type { PageTextBlock } from '../models/document'

export interface TextIndexQuery {
  query: string
  documentId?: string
  limit?: number
}

export interface TextIndexHit {
  block: PageTextBlock
  score?: number
}

export interface TextIndex {
  upsert(blocks: readonly PageTextBlock[]): Promise<void>
  search(query: TextIndexQuery): Promise<readonly TextIndexHit[]>
  removeDocument(documentId: string): Promise<void>
}
