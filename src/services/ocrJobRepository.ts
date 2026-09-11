import type { OcrJob } from '../models/document'

export interface OcrJobRepository {
  getById(jobId: string): Promise<OcrJob | null>
  listByDocument(documentId: string): Promise<readonly OcrJob[]>
  save(job: OcrJob): Promise<void>
}
