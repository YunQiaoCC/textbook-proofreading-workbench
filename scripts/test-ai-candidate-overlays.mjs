#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stableCandidateId } from '../server/candidates/candidateContract.mjs'
import { createIngestionServer } from '../server/app.mjs'
import {
  aiCandidateNavigation,
  aiOverlayPercentRect,
  aiOverlayTone,
  aiOverlaysVisibleForStage,
  deriveAiCandidateOverlays,
} from '../shared/aiCandidateOverlay.js'
import { annotationEditingEnabled } from '../shared/workbenchState.js'

const timestamp = '2026-01-01T00:00:00.000Z'
const reviewerName = '合成复审员'
let testCount = 0

function candidate(documentId, chapterId, suffix, overrides = {}) {
  const value = {
    schemaVersion: '0.1', id: '', documentId, chapterId, pdfPage: 2, blockId: `block-${suffix}`,
    originalText: `仅供本地测试的候选 ${suffix}`, issueType: 'typo', ruleType: 'static', severity: 'minor',
    extractionReliability: 'high', verificationStatus: 'not_required', retrievalRequired: 'no', evidence: [],
    judgement: 'confirmed_error', suggestion: `本地测试建议 ${suffix}`, reason: `本地测试理由 ${suffix}`,
    confidence: 'high', humanResolution: 'pending', ...overrides,
  }
  value.id = stableCandidateId(value)
  return value
}

function pageArtifact(documentId) {
  const block = (id, x, y, overrides = {}) => ({
    id, documentId, pdfPage: 2, order: 1, type: 'paragraph', text: `不应由 overlay API 返回的教材文本 ${id}`,
    source: 'pdf_text', bbox: { x, y, width: 180, height: 18 }, ...overrides,
  })
  return {
    documentId, pdfPage: 2, source: 'pdf_text', status: 'ready', classification: 'native_ready', charCount: 100,
    quality: {}, bboxCount: 5,
    coordinateSystem: { unit: 'pt', origin: 'top-left', xAxis: 'right', yAxis: 'down', pageWidth: 612, pageHeight: 792 },
    blocks: [
      block('block-pending', 72, 72),
      block('block-accepted', 72, 110),
      block('block-modified', 72, 148),
      block('block-rejected', 72, 186),
      block('block-wrong-page', 72, 224, { pdfPage: 3 }),
    ],
    updatedAt: timestamp,
  }
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function request(baseUrl, route, { method = 'GET', body, cookie } = {}) {
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

async function test(name, operation) {
  await operation()
  testCount += 1
  console.log(`${name}=pass`)
}

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'ai-candidate-overlays-'))
  let modelRequests = 0
  let retrievalRequests = 0
  const app = await createIngestionServer({
    storageRoot,
    authRequired: true,
    accessUsername: 'tester',
    accessPassword: 'secret',
    modelClient: {
      getStatus: () => ({ configured: true, provider: 'deepseek', model: 'mock-only' }),
      requestStructured: async () => { modelRequests += 1; throw new Error('AI must not be called') },
    },
    retrievalAdapter: {
      retrieve: async () => { retrievalRequests += 1; throw new Error('retrieval must not be called') },
      close: async () => {},
    },
  })
  const baseUrl = await listen(app)

  try {
    const documentId = 'ai-overlay-document'
    await app.documentRepository.saveBundle({
      document: { id: documentId, title: 'Overlay fixture', originalAssetId: '', pageCount: 8, processingStatus: 'ready', createdAt: timestamp, updatedAt: timestamp },
      asset: null, pages: [],
    })
    const chapter = await app.chapterService.create(documentId, {
      title: '第一章', order: 1, startPdfPage: 1, endPdfPage: 4, status: 'in_progress', assigneeName: reviewerName,
    })
    const otherChapter = await app.chapterService.create(documentId, {
      title: '第二章', order: 2, startPdfPage: 5, endPdfPage: 8, status: 'not_started', assigneeName: reviewerName,
    })
    await app.textRepository.writePage(pageArtifact(documentId))

    const candidates = [
      candidate(documentId, chapter.id, 'pending'),
      candidate(documentId, chapter.id, 'accepted'),
      candidate(documentId, chapter.id, 'modified'),
      candidate(documentId, chapter.id, 'rejected'),
      candidate(documentId, chapter.id, 'missing'),
      candidate(documentId, chapter.id, 'wrong-page'),
    ]
    let workspace = await app.aiReviewService.startAiRun(documentId, chapter.id, 0)
    workspace = await app.aiReviewService.completeAiRun(documentId, chapter.id, candidates, workspace.revision)
    workspace = await app.aiReviewService.startHumanReview(documentId, chapter.id, reviewerName, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[1].id, { status: 'accepted', resolvedBy: reviewerName }, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[2].id, {
      status: 'modified', resolvedBy: reviewerName,
      modifiedResult: { originalText: '人工修订', issueType: 'wording', suggestion: '修订建议', pdfPage: 3 },
    }, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[3].id, { status: 'rejected', resolvedBy: reviewerName }, workspace.revision)

    const humanWorkspace = await app.proofreadingService.saveChapter(documentId, chapter.id, {
      baseRevision: 0,
      annotations: [{ id: 'human-annotation', kind: 'text-markup', pageIndex: 1, geometry: { type: 'rect', x: 1, y: 1, width: 2, height: 2 } }],
      issues: [{ id: 'human-issue', annotationId: 'human-annotation', pdfPage: 2, originalText: '人工原文', category: 'typo', suggestion: '人工建议', reason: '', status: 'pending', reviewer: reviewerName, verifier: '', createdAt: timestamp, updatedAt: timestamp }],
    })

    const route = `/api/documents/${documentId}/chapters/${chapter.id}/ai-review/overlays`
    await test('overlay-endpoint-authenticated', async () => {
      const unauthenticated = await request(baseUrl, route)
      assert.equal(unauthenticated.response.status, 401)
      const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'secret' } })
      assert.equal(login.response.status, 200)
    })
    const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'secret' } })
    const cookie = login.response.headers.get('set-cookie').split(';', 1)[0]
    const result = await request(baseUrl, route, { cookie })

    await test('authoritative-block-id-resolves-exact-bbox', async () => {
      assert.equal(result.response.status, 200)
      const pending = result.body.overlays.find((overlay) => overlay.candidateId === candidates[0].id)
      assert.deepEqual(pending, {
        candidateId: candidates[0].id, pdfPage: 2, blockId: 'block-pending',
        bbox: { x: 72, y: 72, width: 180, height: 18 },
        page: { width: 612, height: 792, unit: 'pt', origin: 'top-left' }, resolutionStatus: 'pending',
      })
      assert.equal(JSON.stringify(result.body).includes('不应由 overlay API 返回'), false)
    })

    await test('missing-or-wrong-block-safely-skipped', async () => {
      assert.equal(result.body.overlays.some((overlay) => overlay.candidateId === candidates[4].id), false)
      assert.equal(result.body.overlays.some((overlay) => overlay.candidateId === candidates[5].id), false)
      assert.equal(result.body.overlays.length, 4)
    })

    const geometries = result.body.overlays
    await test('pending-marker-and-block-level-percent-geometry', async () => {
      assert.equal(aiOverlaysVisibleForStage('awaiting_human_review'), true)
      assert.equal(aiOverlaysVisibleForStage('human_review_in_progress'), true)
      assert.equal(aiOverlaysVisibleForStage('ai_running'), false)
      const overlays = deriveAiCandidateOverlays(workspace.candidates, geometries, workspace.stage)
      const pending = overlays.find((overlay) => overlay.candidateId === candidates[0].id)
      assert.equal(pending.id, `ai-overlay:${candidates[0].id}`)
      assert.equal(pending.readOnly, true)
      assert.equal(aiOverlayTone(pending.resolutionStatus), 'pending')
      assert.deepEqual(aiOverlayPercentRect(pending), {
        left: `${(72 / 612) * 100}%`, top: `${(72 / 792) * 100}%`,
        width: `${(180 / 612) * 100}%`, height: `${(18 / 792) * 100}%`,
      })
    })

    await test('accepted-status-updates-derived-visual-state', async () => {
      const overlay = deriveAiCandidateOverlays(workspace.candidates, geometries, workspace.stage).find((value) => value.candidateId === candidates[1].id)
      assert.equal(overlay.resolutionStatus, 'accepted')
      assert.equal(aiOverlayTone(overlay.resolutionStatus), 'accepted')
    })

    await test('modified-status-updates-derived-visual-state', async () => {
      const overlay = deriveAiCandidateOverlays(workspace.candidates, geometries, workspace.stage).find((value) => value.candidateId === candidates[2].id)
      assert.equal(overlay.resolutionStatus, 'modified')
      assert.equal(aiOverlayTone(overlay.resolutionStatus), 'modified')
    })

    await test('rejected-candidate-overlay-hidden', async () => {
      assert.equal(deriveAiCandidateOverlays(workspace.candidates, geometries, workspace.stage).some((value) => value.candidateId === candidates[3].id), false)
    })

    await test('overlay-click-selection-key-is-ai-candidate-only', async () => {
      assert.deepEqual(aiCandidateNavigation(candidates[0]), { candidateId: candidates[0].id, queueKey: `ai:${candidates[0].id}`, pdfPage: 2 })
    })

    await test('candidate-click-navigation-uses-candidate-pdf-page', async () => {
      assert.equal(aiCandidateNavigation(candidates[2]).pdfPage, candidates[2].pdfPage)
    })

    await test('overlay-does-not-create-proofreading-issue-or-annotation', async () => {
      const before = structuredClone(humanWorkspace)
      const overlays = deriveAiCandidateOverlays(workspace.candidates, geometries, workspace.stage)
      assert.equal(overlays.some((overlay) => 'annotationId' in overlay || 'kind' in overlay || 'payload' in overlay), false)
      assert.deepEqual(await app.proofreadingService.getChapter(documentId, chapter.id), before)
    })

    await test('human-annotation-events-never-mutate-candidate', async () => {
      const candidatesBefore = structuredClone(workspace.candidates)
      const annotations = structuredClone(humanWorkspace.annotations)
      annotations.push({ id: 'another-human-annotation', kind: 'text-markup' })
      annotations.splice(1, 1)
      assert.deepEqual(workspace.candidates, candidatesBefore)
    })

    await test('candidate-resolution-never-deletes-human-annotation', async () => {
      const before = structuredClone((await app.proofreadingService.getChapter(documentId, chapter.id)).annotations)
      workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[0].id, { status: 'accepted', resolvedBy: reviewerName }, workspace.revision)
      workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[4].id, { status: 'rejected', resolvedBy: reviewerName }, workspace.revision)
      workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, candidates[5].id, { status: 'rejected', resolvedBy: reviewerName }, workspace.revision)
      assert.deepEqual((await app.proofreadingService.getChapter(documentId, chapter.id)).annotations, before)
    })

    await test('completed-pdf-readonly-and-overlays-remain-visible', async () => {
      workspace = await app.aiReviewService.completeHumanReview(documentId, chapter.id, reviewerName, workspace.revision)
      assert.equal(annotationEditingEnabled(workspace.stage, true), false)
      assert.equal(aiOverlaysVisibleForStage(workspace.stage), true)
    })

    await test('rollback-reenables-human-annotations-with-overlay-intact', async () => {
      workspace = await app.aiReviewService.rollback(documentId, chapter.id, 'human_review_in_progress', reviewerName, workspace.revision)
      assert.equal(annotationEditingEnabled(workspace.stage, true), true)
      const refreshed = await app.aiCandidateOverlayService.list(documentId, chapter.id)
      assert.equal(deriveAiCandidateOverlays(workspace.candidates, refreshed.overlays, workspace.stage).length, 3)
    })

    await test('ai-overlay-readonly-and-handler-isolation-in-ui', async () => {
      const overlaySource = await readFile(new URL('../src/components/AiCandidatePdfOverlay.vue', import.meta.url), 'utf8')
      const workbenchSource = await readFile(new URL('../src/WorkbenchView.vue', import.meta.url), 'utf8')
      assert.equal(/handleAnnotationAdded|handleAnnotationUpdated|handleAnnotationDeleted|handleSave|ensureIssueForAnnotation|useAnnotationStore/.test(overlaySource), false)
      assert.match(overlaySource, /emit\('select', overlay\.candidateId\)/)
      assert.match(overlaySource, /scrollIntoView/)
      assert.match(workbenchSource, /<AiCandidatePdfOverlay/)
      assert.match(workbenchSource, /@annotation-added="handleAnnotationAdded"/)
      assert.match(workbenchSource, /@save="handleSave"/)
    })

    await test('overlay-endpoint-is-current-chapter-only', async () => {
      const other = await request(baseUrl, `/api/documents/${documentId}/chapters/${otherChapter.id}/ai-review/overlays`, { cookie })
      assert.equal(other.response.status, 200)
      assert.deepEqual(other.body.overlays, [])
    })

    assert.equal(modelRequests, 0)
    assert.equal(retrievalRequests, 0)
    assert.equal(testCount, 16)
    console.log(`ai-candidate-overlay-test-count=${testCount}`)
    console.log('block-level-highlight=yes word-level-highlight=no')
    console.log('human-annotation-persistence-writes=0')
    console.log('external-ai-and-retrieval-requests=0')
  } finally {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main()
