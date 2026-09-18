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

function statusForClassification(classification) {
  if (classification === 'native_suspicious') return 'suspicious'
  if (classification === 'ocr_required') return 'ocr_required'
  return 'ready'
}

function triageReason(artifact) {
  if (artifact.classification === 'ocr_not_needed') return 'empty_native_text_and_visually_blank'
  if (artifact.classification === 'ocr_required' && artifact.visualTriage?.hasSubstantiveVisualContent) {
    return 'empty_native_text_with_substantive_visual_content'
  }
  if (artifact.status === 'failed') return 'native_extraction_failed'
  const prefix = artifact.classification === 'native_suspicious' ? 'native_text_suspicious' : 'hard_quality_trigger'
  return `${prefix}:${artifact.quality.flags.join(',') || 'unclassified'}`
}

export class DocumentTextService {
  constructor({ documentRepository, documentStorage, textRepository, extractor, visualTriage, lifecycleCoordinator, now = () => new Date() }) {
    this.documentRepository = documentRepository
    this.documentStorage = documentStorage
    this.textRepository = textRepository
    this.extractor = extractor
    this.visualTriage = visualTriage
    this.lifecycleCoordinator = lifecycleCoordinator
    this.now = now
    this.queue = []
    this.queuedIds = new Set()
    this.activeDocumentId = null
    this.idleWaiters = new Set()
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
      if (this.queue.length > 0) {
        queueMicrotask(() => { void this.drain() })
      } else {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  async waitForIdle() {
    if (!this.activeDocumentId && this.queue.length === 0) return
    await new Promise((resolve) => this.idleWaiters.add(resolve))
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
      nativeReadyPages: 0,
      nativeSuspiciousPages: 0,
      ocrRequiredPages: 0,
      ocrNotNeededPages: 0,
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

  async saveTriageReportIfDocumentExists(documentId, report) {
    return this.lifecycleCoordinator.withDocumentLock(documentId, async () => {
      if (!(await this.documentRepository.getById(documentId))) throw new DocumentNotFoundError(documentId)
      await this.textRepository.writeTriageReport(report)
    })
  }

  async run(documentId, { resume }) {
    const record = await this.documentRepository.readRecord(documentId)
    if (!record?.document || !record.asset) throw new DocumentNotFoundError(documentId)
    const { document, asset } = record
    const pdfPath = this.documentStorage.resolveAbsolutePath(asset)
    const previous = await this.textRepository.readSummary(documentId)
    if (!previous) return
    const previousTriageReport = await this.textRepository.readTriageReport(documentId)
    const originalPreviousStatuses = new Map(
      (previousTriageReport?.candidates ?? []).map((candidate) => [candidate.pdfPage, candidate.previousStatus]),
    )
    const startedClock = performance.now()
    let peakRssBytes = process.memoryUsage().rss
    let summary = {
      ...previous,
      status: 'processing',
      totalPages: document.pageCount,
      processedPages: 0,
      nativeTextPages: 0,
      nativeReadyPages: 0,
      nativeSuspiciousPages: 0,
      ocrRequiredPages: 0,
      ocrNotNeededPages: 0,
      failedPages: 0,
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      completedAt: undefined,
      errorMessage: undefined,
    }
    await this.saveSummaryIfDocumentExists(documentId, summary)
    const candidates = []

    for (let pdfPage = 1; pdfPage <= document.pageCount; pdfPage += 1) {
      const previousArtifact = await this.textRepository.readPage(documentId, pdfPage)
      const existing = resume ? previousArtifact : null
      let artifact = existing?.classification && ['ready', 'suspicious', 'ocr_required'].includes(existing.status) ? existing : null
      if (!artifact) {
        const updatedAt = this.now().toISOString()
        try {
          const extracted = await this.extractor.extractPage({ documentId, pdfPath, pdfPage })
          const quality = evaluateNativeTextQuality(extracted.text, extracted)
          let classification = quality.classification
          let visualTriage
          if (quality.nonWhitespaceCharCount === 0) {
            visualTriage = await this.visualTriage.classifyPage({ documentId, pdfPath, pdfPage })
            classification = visualTriage.hasSubstantiveVisualContent ? 'ocr_required' : 'ocr_not_needed'
          }
          const hasNativeText = ['native_ready', 'native_suspicious'].includes(classification)
          artifact = {
            documentId,
            pdfPage,
            source: hasNativeText ? 'pdf_text' : 'none',
            status: statusForClassification(classification),
            classification,
            charCount: quality.charCount,
            quality,
            coordinateSystem: extracted.coordinateSystem,
            ...(visualTriage ? { visualTriage } : {}),
            blocks: hasNativeText ? extracted.blocks : [],
            updatedAt,
          }
        } catch (error) {
          artifact = {
            documentId,
            pdfPage,
            source: 'none',
            status: 'failed',
            classification: 'ocr_required',
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
      if (artifact.classification === 'native_ready') {
        summary.nativeReadyPages += 1
        summary.nativeTextPages += 1
      } else if (artifact.classification === 'native_suspicious') {
        summary.nativeSuspiciousPages += 1
        summary.nativeTextPages += 1
      } else if (artifact.classification === 'ocr_required' && artifact.status !== 'failed') {
        summary.ocrRequiredPages += 1
      } else if (artifact.classification === 'ocr_not_needed') {
        summary.ocrNotNeededPages += 1
      } else {
        summary.failedPages += 1
      }
      if (artifact.classification !== 'native_ready' || artifact.status === 'failed') {
        candidates.push({
          pdfPage,
          previousStatus: originalPreviousStatuses.get(pdfPage) ?? previousArtifact?.status ?? 'pending',
          qualityFlags: artifact.quality.flags,
          charCount: artifact.charCount,
          recommendedClass: artifact.classification,
          reason: triageReason(artifact),
        })
      }
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
    await this.saveTriageReportIfDocumentExists(documentId, {
      documentId,
      generatedAt: this.now().toISOString(),
      candidates,
    })
  }
}
