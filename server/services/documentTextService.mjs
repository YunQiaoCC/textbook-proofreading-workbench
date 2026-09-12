import { randomUUID } from 'node:crypto'
import { DocumentNotFoundError } from './documentLifecycleCoordinator.mjs'
import { evaluateNativeTextQuality } from './nativeTextQuality.mjs'

const SAFE_DOCUMENT_ID = /^[A-Za-z0-9-]+$/

function assertDocumentId(documentId) {
  if (typeof documentId !== 'string' || !SAFE_DOCUMENT_ID.test(documentId)) {
    throw new DocumentNotFoundError(documentId)
  }
}

function emptyQuality() {
  return evaluateNativeTextQuality('', { lineCount: 0, wordCount: 0, bboxCount: 0 })
}

export class DocumentTextService {
  constructor({ documentRepository, documentStorage, textRepository, extractor, lifecycleCoordinator, now = () => new Date() }) {
    this.documentRepository = documentRepository
    this.documentStorage = documentStorage
    this.textRepository = textRepository
    this.extractor = extractor
    this.lifecycleCoordinator = lifecycleCoordinator
    this.now = now
    this.queue = []
    this.queuedIds = new Set()
    this.activeDocumentId = null
  }

  async init() {
    await this.textRepository.init()
    const summaries = await this.textRepository.listSummaries()
    for (const summary of summaries) {
      if (!['processing', 'queued'].includes(summary.status)) continue
      const document = await this.documentRepository.getById(summary.documentId)
      if (!document) {
        await this.textRepository.removeDocument(summary.documentId)
        continue
      }
      const recovered = {
        ...summary,
        status: 'queued',
        updatedAt: this.now().toISOString(),
        errorMessage: undefined,
      }
      await this.textRepository.writeSummary(recovered)
      this.enqueue(summary.documentId, true)
    }
  }

  enqueue(documentId, resume) {
    if (this.queuedIds.has(documentId) || this.activeDocumentId === documentId) return
    this.queuedIds.add(documentId)
    this.queue.push({ documentId, resume })
    queueMicrotask(() => { void this.drain() })
  }

  async drain() {
    if (this.activeDocumentId || this.queue.length === 0) return
    const job = this.queue.shift()
    this.queuedIds.delete(job.documentId)
    this.activeDocumentId = job.documentId
    try {
      await this.run(job.documentId, { resume: job.resume })
    } catch (error) {
      if (!(error instanceof DocumentNotFoundError)) console.error('document text extraction failed', error)
    } finally {
      this.activeDocumentId = null
      if (this.queue.length > 0) queueMicrotask(() => { void this.drain() })
    }
  }

  async start(documentId) {
    assertDocumentId(documentId)
    const document = await this.documentRepository.getById(documentId)
    if (!document) throw new DocumentNotFoundError(documentId)
    if (document.processingStatus !== 'ready' || !Number.isSafeInteger(document.pageCount) || document.pageCount < 1) {
      const error = new Error('Document PDF is not ready for text extraction')
      error.code = 'document_not_ready'
      throw error
    }
    const existing = await this.textRepository.readSummary(documentId)
    if (existing && ['queued', 'processing'].includes(existing.status)) return existing
    const timestamp = this.now().toISOString()
    const summary = {
      id: randomUUID(),
      documentId,
      status: 'queued',
      totalPages: document.pageCount,
      processedPages: 0,
      nativeTextPages: 0,
      ocrRequiredPages: 0,
      failedPages: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.textRepository.writeSummary(summary)
    this.enqueue(documentId, false)
    return summary
  }

  async status(documentId) {
    assertDocumentId(documentId)
    if (!(await this.documentRepository.getById(documentId))) throw new DocumentNotFoundError(documentId)
    return await this.textRepository.readSummary(documentId) ?? null
  }

  async page(documentId, pdfPage) {
    assertDocumentId(documentId)
    if (!Number.isSafeInteger(pdfPage) || pdfPage < 1) {
      const error = new Error('pdfPage must be a one-based positive integer')
      error.code = 'invalid_pdf_page'
      throw error
    }
    const document = await this.documentRepository.getById(documentId)
    if (!document) throw new DocumentNotFoundError(documentId)
    if (pdfPage > document.pageCount) {
      const error = new Error('pdfPage is outside the document')
      error.code = 'invalid_pdf_page'
      throw error
    }
    return await this.textRepository.readPage(documentId, pdfPage)
  }

  async saveSummaryIfDocumentExists(documentId, summary) {
    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      if (!(await this.documentRepository.getById(documentId))) throw new DocumentNotFoundError(documentId)
      await this.textRepository.writeSummary(summary)
    })
  }

  async savePageIfDocumentExists(documentId, artifact) {
    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      if (!(await this.documentRepository.getById(documentId))) throw new DocumentNotFoundError(documentId)
      await this.textRepository.writePage(artifact)
    })
  }

  async run(documentId, { resume }) {
    const record = await this.documentRepository.readRecord(documentId)
    if (!record?.document || !record.asset) throw new DocumentNotFoundError(documentId)
    const { document, asset } = record
    const pdfPath = this.documentStorage.resolveAbsolutePath(asset)
    const previous = await this.textRepository.readSummary(documentId)
    if (!previous) return
    const startedClock = performance.now()
    let peakRssBytes = process.memoryUsage().rss
    let summary = {
      ...previous,
      status: 'processing',
      totalPages: document.pageCount,
      processedPages: 0,
      nativeTextPages: 0,
      ocrRequiredPages: 0,
      failedPages: 0,
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      completedAt: undefined,
      errorMessage: undefined,
    }
    await this.saveSummaryIfDocumentExists(documentId, summary)

    for (let pdfPage = 1; pdfPage <= document.pageCount; pdfPage += 1) {
      const existing = resume ? await this.textRepository.readPage(documentId, pdfPage) : null
      let artifact = existing && ['ready', 'ocr_required'].includes(existing.status) ? existing : null
      if (!artifact) {
        const updatedAt = this.now().toISOString()
        try {
          const extracted = await this.extractor.extractPage({ documentId, pdfPath, pdfPage })
          const quality = evaluateNativeTextQuality(extracted.text, extracted)
          artifact = quality.usable
            ? {
                documentId,
                pdfPage,
                source: 'pdf_text',
                status: 'ready',
                charCount: quality.charCount,
                quality,
                coordinateSystem: extracted.coordinateSystem,
                blocks: extracted.blocks,
                updatedAt,
              }
            : {
                documentId,
                pdfPage,
                source: 'none',
                status: 'ocr_required',
                charCount: quality.charCount,
                quality,
                coordinateSystem: extracted.coordinateSystem,
                blocks: [],
                updatedAt,
              }
        } catch (error) {
          artifact = {
            documentId,
            pdfPage,
            source: 'none',
            status: 'failed',
            charCount: 0,
            quality: emptyQuality(),
            coordinateSystem: null,
            blocks: [],
            updatedAt,
            errorMessage: error instanceof Error ? error.message : String(error),
          }
        }
        await this.savePageIfDocumentExists(documentId, artifact)
      }

      summary.processedPages += 1
      if (artifact.status === 'ready') summary.nativeTextPages += 1
      else if (artifact.status === 'ocr_required') summary.ocrRequiredPages += 1
      else summary.failedPages += 1
      summary.updatedAt = this.now().toISOString()
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
      await this.saveSummaryIfDocumentExists(documentId, summary)
    }

    summary = {
      ...summary,
      status: summary.failedPages > 0 ? 'failed' : 'completed',
      completedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      metrics: {
        totalSeconds: Number(((performance.now() - startedClock) / 1000).toFixed(3)),
        peakRssMb: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
      },
      ...(summary.failedPages > 0 ? { errorMessage: `${summary.failedPages} page(s) failed` } : {}),
    }
    await this.saveSummaryIfDocumentExists(documentId, summary)
  }
}
