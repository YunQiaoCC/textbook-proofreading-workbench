#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'
const pdf = Buffer.from('%PDF-1.4\\n')

function fixtureDocument(id, title) {
  return {
    id,
    title,
    originalAssetId: '',
    pageCount: 20,
    processingStatus: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

async function createDocument(app, id, title) {
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  const asset = await app.documentStorage.storeOriginalPdf({
    documentId: id,
    byteSize: pdf.length,
    sha256,
    content: pdf,
  })
  const document = { ...fixtureDocument(id, title), originalAssetId: asset.id }
  const pages = Array.from({ length: document.pageCount }, (_, index) => ({
    id: id + '-page-' + (index + 1),
    documentId: id,
    pdfPage: index + 1,
  }))
  await app.documentRepository.saveBundle({ document, asset, pages })
  return document
}

function chapterBody(title, order) {
  return {
    title,
    order,
    startPdfPage: 1,
    endPdfPage: 10,
    status: 'not_started',
  }
}

function workspacePayload(baseRevision, suffix) {
  const annotationId = 'annotation-' + suffix
  return {
    baseRevision,
    annotations: [{ id: annotationId, kind: 'highlight', payload: { selectedText: suffix } }],
    issues: [{
      id: 'issue-' + suffix,
      annotationId,
      pdfPage: 2,
      printedPage: '',
      originalText: 'original-' + suffix,
      category: 'typo',
      suggestion: 'suggestion-' + suffix,
      reason: '',
      status: 'pending',
      reviewer: 'test-reviewer',
      verifier: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return 'http://127.0.0.1:' + app.server.address().port
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, options)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function jsonRequest(baseUrl, route, method, body) {
  return request(baseUrl, route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function assertNotFound(baseUrl, route) {
  const result = await request(baseUrl, route)
  assert.equal(result.response.status, 404)
  assert.equal(result.body.error, 'document_not_found')
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), (error) => error && error.code === 'ENOENT')
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-document-delete-'))
  const app = await createIngestionServer({ storageRoot: root })
  const baseUrl = await listen(app)

  try {
    await createDocument(app, 'document-a', 'Document A')
    await createDocument(app, 'document-b', 'Document B')

    const chapterA = await jsonRequest(baseUrl, '/api/documents/document-a/chapters', 'POST', chapterBody('Chapter A', 1))
    const chapterB = await jsonRequest(baseUrl, '/api/documents/document-a/chapters', 'POST', { ...chapterBody('Chapter B', 2), startPdfPage: 11, endPdfPage: 20 })
    const chapterBDocument = await jsonRequest(baseUrl, '/api/documents/document-b/chapters', 'POST', chapterBody('Document B Chapter', 1))
    assert.equal(chapterA.response.status, 201)
    assert.equal(chapterB.response.status, 201)
    assert.equal(chapterBDocument.response.status, 201)
    await app.aiReviewService.startAiRun('document-a', chapterA.body.id, 0)
    await app.aiReviewService.startAiRun('document-b', chapterBDocument.body.id, 0)
    const bProof = await jsonRequest(
      baseUrl,
      '/api/documents/document-b/chapters/' + chapterBDocument.body.id + '/proofreading',
      'PUT',
      workspacePayload(0, 'b'),
    )
    assert.equal(bProof.response.status, 200)

    const chapterProof = await jsonRequest(
      baseUrl,
      '/api/documents/document-a/chapters/' + chapterA.body.id + '/proofreading',
      'PUT',
      workspacePayload(0, 'a'),
    )
    const legacyProof = await jsonRequest(
      baseUrl,
      '/api/documents/document-a/proofreading',
      'PUT',
      workspacePayload(0, 'legacy'),
    )
    assert.equal(chapterProof.response.status, 200)
    assert.equal(legacyProof.response.status, 200)

    await app.textRepository.writeSummary({
      id: 'text-job-a', documentId: 'document-a', status: 'completed', totalPages: 20,
      processedPages: 20, nativeTextPages: 20, nativeReadyPages: 20, nativeSuspiciousPages: 0,
      ocrRequiredPages: 0, ocrNotNeededPages: 0, failedPages: 0,
      createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp, completedAt: timestamp,
    })
    await app.textRepository.writePage({
      documentId: 'document-a', pdfPage: 1, source: 'pdf_text', status: 'ready', classification: 'native_ready', charCount: 4,
      quality: { usable: true, flags: ['usable_native_text'] }, coordinateSystem: null, blocks: [], updatedAt: timestamp,
    })
    await app.textRepository.writeTriageReport({ documentId: 'document-a', generatedAt: timestamp, candidates: [] })

    const deleted = await request(baseUrl, '/api/documents/document-a', { method: 'DELETE' })
    assert.equal(deleted.response.status, 204)
    assert.equal(deleted.body, null)

    await assertNotFound(baseUrl, '/api/documents/document-a')
    await assertNotFound(baseUrl, '/api/documents/document-a/file')
    await assertNotFound(baseUrl, '/api/documents/document-a/chapters')
    await assertNotFound(baseUrl, '/api/documents/document-a/chapters/' + chapterA.body.id + '/proofreading')
    await assertNotFound(baseUrl, '/api/documents/document-a/proofreading')

    const listed = await request(baseUrl, '/api/documents')
    assert.equal(listed.response.status, 200)
    assert.deepEqual(listed.body.documents.map((document) => document.id), ['document-b'])
    const bStillThere = await request(baseUrl, '/api/documents/document-b')
    assert.equal(bStillThere.response.status, 200)
    const bChaptersStillThere = await request(baseUrl, '/api/documents/document-b/chapters')
    assert.equal(bChaptersStillThere.response.status, 200)
    assert.equal(bChaptersStillThere.body.chapters.length, 1)
    const bProofStillThere = await request(
      baseUrl,
      '/api/documents/document-b/chapters/' + chapterBDocument.body.id + '/proofreading',
    )
    assert.equal(bProofStillThere.response.status, 200)
    assert.equal(bProofStillThere.body.issues[0].id, 'issue-b')
    const bAiReviewStillThere = await app.aiReviewService.get('document-b', chapterBDocument.body.id)
    assert.equal(bAiReviewStillThere.stage, 'ai_running')

    await assertMissing(path.join(root, 'documents', 'document-a'))
    await assertMissing(path.join(root, 'metadata', 'documents', 'document-a.json'))
    await assertMissing(path.join(root, 'metadata', 'proofreading', 'document-a.json'))
    await assertMissing(path.join(root, 'metadata', 'proofreading', 'document-a'))
    await assertMissing(path.join(root, 'metadata', 'ai-reviews', 'document-a'))
    await assertMissing(path.join(root, 'text', 'document-a'))
    await assertMissing(path.join(root, 'metadata', 'text', 'document-a.json'))
    await assertMissing(path.join(root, 'metadata', 'text', 'document-a-ocr-triage.json'))

    const secondDelete = await request(baseUrl, '/api/documents/document-a', { method: 'DELETE' })
    assert.equal(secondDelete.response.status, 404)
    assert.equal(secondDelete.body.error, 'document_not_found')
    const traversal = await request(baseUrl, '/api/documents/%2e%2e%2fetc', { method: 'DELETE' })
    assert.equal(traversal.response.status, 404)
    assert.equal(traversal.body.error, 'document_not_found')

    const concurrentDocumentId = 'concurrency-a'
    await createDocument(app, concurrentDocumentId, 'Concurrency A')
    const concurrentChapter = await jsonRequest(
      baseUrl,
      '/api/documents/' + concurrentDocumentId + '/chapters',
      'POST',
      chapterBody('Concurrency Chapter', 1),
    )
    assert.equal(concurrentChapter.response.status, 201)
    const concurrentRoute = '/api/documents/' + concurrentDocumentId + '/chapters/' + concurrentChapter.body.id + '/proofreading'

    const originalGetById = app.documentRepository.getById.bind(app.documentRepository)
    let getByIdCalls = 0
    let releaseSave
    let saveEntered
    const saveEnteredPromise = new Promise((resolve) => { saveEntered = resolve })
    const releasePromise = new Promise((resolve) => { releaseSave = resolve })
    app.documentRepository.getById = async (documentId) => {
      const result = await originalGetById(documentId)
      if (documentId === concurrentDocumentId && getByIdCalls++ === 1) {
        saveEntered()
        await releasePromise
      }
      return result
    }

    const savePromise = jsonRequest(baseUrl, concurrentRoute, 'PUT', workspacePayload(0, 'concurrent'))
    await saveEnteredPromise
    const deletePromise = request(baseUrl, '/api/documents/' + concurrentDocumentId, { method: 'DELETE' })
    releaseSave()
    const [concurrentSave, concurrentDelete] = await Promise.all([savePromise, deletePromise])
    assert.equal(concurrentSave.response.status, 200)
    assert.equal(concurrentDelete.response.status, 204)
    await assertNotFound(baseUrl, '/api/documents/' + concurrentDocumentId)
    await assertNotFound(baseUrl, concurrentRoute)
    await assertMissing(path.join(root, 'metadata', 'proofreading', concurrentDocumentId))

    const staleSave = await jsonRequest(baseUrl, concurrentRoute, 'PUT', workspacePayload(0, 'stale'))
    assert.equal(staleSave.response.status, 404)
    assert.equal(staleSave.body.error, 'document_not_found')
    await assertMissing(path.join(root, 'metadata', 'proofreading', concurrentDocumentId))

    console.log('document delete cascade, path safety, and concurrent stale-save checks passed')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
