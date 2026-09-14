#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stableCandidateId } from '../server/candidates/candidateContract.mjs'
import { createIngestionServer } from '../server/app.mjs'
import {
  chapterHasWork,
  clearProofreadingClientStateFromStorage,
  nextSelectedChapterId,
  proofreadingClientStorageKey,
} from '../shared/workbenchState.js'

const documentId = 'chapter-delete-document'
const reviewerName = '张三'
const timestamp = '2026-01-01T00:00:00.000Z'

function candidate(chapterId, suffix, pdfPage = 2) {
  const value = {
    schemaVersion: '0.1', id: '', documentId, chapterId, pdfPage, blockId: `block-${suffix}`,
    originalText: `合成候选 ${suffix}`, issueType: 'typo', ruleType: 'static', severity: 'minor',
    extractionReliability: 'high', verificationStatus: 'not_required', retrievalRequired: 'no', evidence: [],
    judgement: 'confirmed_error', suggestion: `合成建议 ${suffix}`, reason: `合成理由 ${suffix}`,
    confidence: 'high', humanResolution: 'pending',
  }
  value.id = stableCandidateId(value)
  return value
}

function proofreadingPayload(chapterId, suffix, pdfPage = 2) {
  const annotationId = `annotation-${suffix}`
  return {
    baseRevision: 0,
    annotations: [{ id: annotationId, kind: 'highlight', payload: { selectedText: suffix } }],
    issues: [{
      id: `issue-${suffix}`, annotationId, pdfPage, printedPage: '', originalText: `原文 ${suffix}`,
      category: 'typo', suggestion: `建议 ${suffix}`, reason: '', status: 'pending', reviewer: reviewerName,
      verifier: '', createdAt: timestamp, updatedAt: timestamp, chapterId,
    }],
  }
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function request(baseUrl, route, method = 'GET', { body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function missing(filePath) {
  await assert.rejects(stat(filePath), (error) => error?.code === 'ENOENT')
}

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'chapter-delete-'))
  let modelRequests = 0
  let retrievalRequests = 0
  const app = await createIngestionServer({
    storageRoot,
    authRequired: true,
    accessUsername: 'tester',
    accessPassword: 'secret',
    modelClient: {
      getStatus: () => ({ configured: true, provider: 'deepseek', model: 'mock-only' }),
      requestStructured: async () => { modelRequests += 1; throw new Error('AI must not be called by chapter delete tests') },
    },
    retrievalAdapter: {
      retrieve: async () => { retrievalRequests += 1; throw new Error('retrieval must not be called by chapter delete tests') },
      close: async () => {},
    },
  })
  const baseUrl = await listen(app)

  try {
    const pdfBytes = Buffer.from('%PDF-1.4 synthetic chapter-delete fixture')
    const sha256 = createHash('sha256').update(pdfBytes).digest('hex')
    const asset = await app.documentStorage.storeOriginalPdf({ documentId, byteSize: pdfBytes.length, sha256, content: [pdfBytes] })
    const documentPages = [{ id: 'page-1', documentId, pdfPage: 1 }]
    await app.documentRepository.saveBundle({
      document: { id: documentId, title: 'Chapter delete fixture', originalAssetId: asset.id, pageCount: 10, processingStatus: 'ready', createdAt: timestamp, updatedAt: timestamp },
      asset, pages: documentPages,
    })
    const chapterA = await app.chapterService.create(documentId, { title: '第一章', order: 1, startPdfPage: 1, endPdfPage: 3, status: 'in_progress', assigneeName: reviewerName })
    const chapterB = await app.chapterService.create(documentId, { title: '第二章', order: 2, startPdfPage: 4, endPdfPage: 6, status: 'completed', assigneeName: reviewerName })
    const chapterC = await app.chapterService.create(documentId, { title: '第三章', order: 3, startPdfPage: 7, endPdfPage: 8, status: 'not_started', assigneeName: reviewerName })
    const chapterD = await app.chapterService.create(documentId, { title: '第四章', order: 4, startPdfPage: 9, endPdfPage: 10, status: 'not_started', assigneeName: reviewerName })

    const unauthenticatedDelete = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterC.id}`, 'DELETE')
    assert.equal(unauthenticatedDelete.response.status, 401)
    const login = await request(baseUrl, '/api/auth/login', 'POST', { body: { username: 'tester', password: 'secret' } })
    assert.equal(login.response.status, 200)
    const cookie = login.response.headers.get('set-cookie').split(';', 1)[0]

    await app.textRepository.writePage({ documentId, pdfPage: 1, text: '合成提取文本', blocks: [] })
    await app.textRepository.writeSummary({ documentId, status: 'completed', totalPages: 10 })

    let reviewA = await app.aiReviewService.startAiRun(documentId, chapterA.id, 0)
    reviewA = await app.aiReviewService.completeAiRun(documentId, chapterA.id, [candidate(chapterA.id, 'other')], reviewA.revision)
    const proofA = await app.proofreadingService.saveChapter(documentId, chapterA.id, proofreadingPayload(chapterA.id, 'other'))

    let reviewB = await app.aiReviewService.startAiRun(documentId, chapterB.id, 0)
    reviewB = await app.aiReviewService.completeAiRun(documentId, chapterB.id, [candidate(chapterB.id, 'deleted', 5)], reviewB.revision)
    const proofB = await app.proofreadingService.saveChapter(documentId, chapterB.id, proofreadingPayload(chapterB.id, 'deleted', 5))
    assert.equal(chapterHasWork(chapterB, reviewB, proofB), true)

    const emptyDelete = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterC.id}`, 'DELETE', { cookie })
    assert.equal(emptyDelete.response.status, 204)
    assert.equal(await app.documentRepository.getChapter(documentId, chapterC.id), null)

    const populatedDelete = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterB.id}`, 'DELETE', { cookie })
    assert.equal(populatedDelete.response.status, 204)
    assert.equal(await app.documentRepository.getChapter(documentId, chapterB.id), null)
    assert.equal(await app.aiReviewRepository.get(documentId, chapterB.id), null)
    assert.equal(await app.proofreadingRepository.getChapter(documentId, chapterB.id), null)
    await missing(app.aiReviewRepository.recordPath(documentId, chapterB.id))
    await missing(app.proofreadingRepository.chapterRecordPath(documentId, chapterB.id))

    const recordAfterDelete = await app.documentRepository.readRecord(documentId)
    assert.equal(recordAfterDelete.asset.id, asset.id)
    assert.deepEqual(recordAfterDelete.pages, documentPages)
    assert.equal(await app.documentStorage.exists(asset), true)
    assert.equal((await app.textRepository.readPage(documentId, 1)).text, '合成提取文本')
    assert.equal((await app.textRepository.readSummary(documentId)).status, 'completed')
    assert.ok(await app.documentRepository.getChapter(documentId, chapterA.id))
    assert.deepEqual(await app.aiReviewRepository.get(documentId, chapterA.id), reviewA)
    assert.deepEqual(await app.proofreadingRepository.getChapter(documentId, chapterA.id), proofA)

    const running = await app.aiReviewService.startAiRun(documentId, chapterD.id, 0)
    const runningDelete = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterD.id}`, 'DELETE', { cookie })
    assert.equal(runningDelete.response.status, 409)
    assert.equal(runningDelete.body.error, 'chapter_ai_running')
    assert.equal((await app.aiReviewRepository.get(documentId, chapterD.id)).revision, running.revision)
    assert.ok(await app.documentRepository.getChapter(documentId, chapterD.id))

    const nonexistent = await request(baseUrl, `/api/documents/${documentId}/chapters/does-not-exist`, 'DELETE', { cookie })
    assert.equal(nonexistent.response.status, 404)
    assert.equal(nonexistent.body.error, 'chapter_not_found')
    const traversal = await request(baseUrl, `/api/documents/${documentId}/chapters/%2e%2e%2fetc`, 'DELETE', { cookie })
    assert.equal(traversal.response.status, 404)

    const ordered = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    assert.equal(nextSelectedChapterId(ordered, 'b', 'b'), 'c')
    assert.equal(nextSelectedChapterId(ordered, 'c', 'c'), 'b')
    assert.equal(nextSelectedChapterId([{ id: 'a' }], 'a', 'a'), null)
    assert.equal(nextSelectedChapterId(ordered, 'a', 'b'), 'a')

    const chapterAKey = proofreadingClientStorageKey(documentId, chapterA.id)
    const chapterDKey = proofreadingClientStorageKey(documentId, chapterD.id)
    const otherDocumentKey = proofreadingClientStorageKey('other-document', 'chapter-a')
    const storage = {
      [chapterAKey]: '{}', [chapterDKey]: '{}', [otherDocumentKey]: '{}',
      removeItem(key) { delete this[key] },
    }
    clearProofreadingClientStateFromStorage(storage, documentId, chapterA.id)
    assert.equal(Object.hasOwn(storage, chapterAKey), false)
    assert.equal(Object.hasOwn(storage, chapterDKey), true)
    assert.equal(Object.hasOwn(storage, otherDocumentKey), true)
    assert.equal(modelRequests, 0)
    assert.equal(retrievalRequests, 0)

    console.log('delete-empty-chapter=pass')
    console.log('chapter-delete-requires-authentication=pass')
    console.log('chapter-metadata-and-workspaces-removed=pass')
    console.log('pdf-asset-and-extracted-text-preserved=pass')
    console.log('other-chapter-data-preserved=pass')
    console.log('ai-running-delete-rejected=pass')
    console.log('nonexistent-and-traversal-rejected=pass')
    console.log('frontend-selection-fallback=pass')
    console.log('chapter-local-client-state-only=pass')
    console.log('chapter-delete-external-ai-and-retrieval-requests=0')
  } finally {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main()
