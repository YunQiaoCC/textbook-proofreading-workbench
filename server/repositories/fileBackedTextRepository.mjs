import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { atomicWriteJson, ensureDirectory, readJson } from '../utils/fs.mjs'

const SAFE_DOCUMENT_ID = /^[A-Za-z0-9-]+$/

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function assertDocumentId(documentId) {
  if (typeof documentId !== 'string' || !SAFE_DOCUMENT_ID.test(documentId)) {
    throw new Error('Invalid document identifier')
  }
}

function assertPdfPage(pdfPage) {
  if (!Number.isSafeInteger(pdfPage) || pdfPage < 1) throw new Error('Invalid one-based PDF page')
}

export class FileBackedTextRepository {
  constructor(storageRoot) {
    this.pagesRoot = path.resolve(storageRoot, 'text')
    this.metadataRoot = path.resolve(storageRoot, 'metadata', 'text')
  }

  async init() {
    await Promise.all([ensureDirectory(this.pagesRoot), ensureDirectory(this.metadataRoot)])
  }

  documentTextDirectory(documentId) {
    assertDocumentId(documentId)
    const result = path.resolve(this.pagesRoot, documentId)
    if (!isWithinRoot(this.pagesRoot, result)) throw new Error('Text directory escapes storage root')
    return result
  }

  pagePath(documentId, pdfPage) {
    assertPdfPage(pdfPage)
    const pagesDirectory = path.resolve(this.documentTextDirectory(documentId), 'pages')
    const result = path.resolve(pagesDirectory, `${String(pdfPage).padStart(6, '0')}.json`)
    if (!isWithinRoot(pagesDirectory, result)) throw new Error('Page text path escapes storage root')
    return result
  }

  summaryPath(documentId) {
    assertDocumentId(documentId)
    const result = path.resolve(this.metadataRoot, `${documentId}.json`)
    if (!isWithinRoot(this.metadataRoot, result)) throw new Error('Text metadata path escapes storage root')
    return result
  }

  triageReportPath(documentId) {
    assertDocumentId(documentId)
    const result = path.resolve(this.metadataRoot, `${documentId}-ocr-triage.json`)
    if (!isWithinRoot(this.metadataRoot, result)) throw new Error('OCR triage metadata path escapes storage root')
    return result
  }

  async writePage(artifact) {
    assertDocumentId(artifact?.documentId)
    assertPdfPage(artifact?.pdfPage)
    await atomicWriteJson(this.pagePath(artifact.documentId, artifact.pdfPage), artifact)
  }

  async readPage(documentId, pdfPage) {
    try {
      return await readJson(this.pagePath(documentId, pdfPage))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async writeSummary(summary) {
    assertDocumentId(summary?.documentId)
    await atomicWriteJson(this.summaryPath(summary.documentId), summary)
  }

  async readSummary(documentId) {
    try {
      return await readJson(this.summaryPath(documentId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async writeTriageReport(report) {
    assertDocumentId(report?.documentId)
    await atomicWriteJson(this.triageReportPath(report.documentId), report)
  }

  async readTriageReport(documentId) {
    try {
      return await readJson(this.triageReportPath(documentId))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async listSummaries() {
    const entries = await readdir(this.metadataRoot, { withFileTypes: true })
    const summaries = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('-ocr-triage.json')) continue
      try {
        summaries.push(await readJson(path.join(this.metadataRoot, entry.name)))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return summaries
  }

  async removeDocument(documentId) {
    await Promise.all([
      rm(this.documentTextDirectory(documentId), { recursive: true, force: true }),
      rm(this.summaryPath(documentId), { force: true }),
      rm(this.triageReportPath(documentId), { force: true }),
    ])
  }
}
