#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stableCandidateId } from '../server/candidates/candidateContract.mjs'
import { createIngestionServer } from '../server/app.mjs'
import { annotationEditingEnabled } from '../shared/workbenchState.js'

const documentId = 'workflow-rollback-document'
const reviewerName = '张三'
const timestamp = '2026-01-01T00:00:00.000Z'

function candidate(chapterId, suffix) {
  const value = {
    schemaVersion: '0.1', id: '', documentId, chapterId, pdfPage: 2, blockId: `block-${suffix}`,
    originalText: `合成候选 ${suffix}`, issueType: 'typo', ruleType: 'static', severity: 'minor',
    extractionReliability: 'high', verificationStatus: 'not_required', retrievalRequired: 'no', evidence: [],
    judgement: 'confirmed_error', suggestion: `合成建议 ${suffix}`, reason: `合成理由 ${suffix}`,
    confidence: 'high', humanResolution: 'pending',
  }
  value.id = stableCandidateId(value)
  return value
}

function manualWorkspace() {
  return {
    baseRevision: 0,
    annotations: [{ id: 'manual-annotation', kind: 'highlight', payload: { selectedText: '人工高亮' } }],
    issues: [{
      id: 'manual-issue', annotationId: 'manual-annotation', pdfPage: 2, printedPage: '',
      originalText: '人工意见原文', category: 'typo', suggestion: '人工意见建议', reason: '',
      status: 'pending', reviewer: reviewerName, verifier: '', createdAt: timestamp, updatedAt: timestamp,
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

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'workflow-rollback-'))
  let modelRequests = 0
  let retrievalRequests = 0
  const app = await createIngestionServer({
    storageRoot,
    authRequired: true,
    accessUsername: 'tester',
    accessPassword: 'secret',
    modelClient: {
      getStatus: () => ({ configured: true, provider: 'deepseek', model: 'mock-only' }),
      requestStructured: async () => { modelRequests += 1; throw new Error('AI must not be called by rollback tests') },
    },
    retrievalAdapter: {
      retrieve: async () => { retrievalRequests += 1; throw new Error('retrieval must not be called by rollback tests') },
      close: async () => {},
    },
  })
  const baseUrl = await listen(app)

  try {
    await app.documentRepository.saveBundle({
      document: { id: documentId, title: 'Workflow fixture', originalAssetId: '', pageCount: 10, processingStatus: 'ready', createdAt: timestamp, updatedAt: timestamp },
      asset: null, pages: [],
    })
    const chapter = await app.chapterService.create(documentId, {
      title: '第一章', order: 1, startPdfPage: 1, endPdfPage: 10, status: 'in_progress', assigneeName: reviewerName,
    })
    const rollbackPath = `/api/documents/${documentId}/chapters/${chapter.id}/ai-review/rollback`

    const unauthenticated = await request(baseUrl, rollbackPath, {
      method: 'POST', body: { targetStage: 'human_review_in_progress', reviewerName, baseRevision: 0 },
    })
    assert.equal(unauthenticated.response.status, 401)

    const login = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { username: 'tester', password: 'secret' } })
    assert.equal(login.response.status, 200)
    const cookie = login.response.headers.get('set-cookie').split(';', 1)[0]

    let workspace = await app.aiReviewService.startAiRun(documentId, chapter.id, 0)
    workspace = await app.aiReviewService.completeAiRun(
      documentId,
      chapter.id,
      [candidate(chapter.id, 'accepted'), candidate(chapter.id, 'modified'), candidate(chapter.id, 'rejected')],
      workspace.revision,
    )
    workspace = await app.aiReviewService.startHumanReview(documentId, chapter.id, reviewerName, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, workspace.candidates[0].candidate.id, { status: 'accepted', resolvedBy: reviewerName }, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, workspace.candidates[1].candidate.id, {
      status: 'modified', resolvedBy: reviewerName,
      modifiedResult: { originalText: '人工修改原文', issueType: 'typo', suggestion: '人工修改建议', reason: '人工修改理由', pdfPage: 2 },
    }, workspace.revision)
    workspace = await app.aiReviewService.resolveCandidate(documentId, chapter.id, workspace.candidates[2].candidate.id, { status: 'rejected', resolvedBy: reviewerName }, workspace.revision)
    const savedProofreading = await app.proofreadingService.saveChapter(documentId, chapter.id, manualWorkspace())
    workspace = await app.aiReviewService.completeHumanReview(documentId, chapter.id, reviewerName, workspace.revision)

    const completedRevision = workspace.revision
    const originalAiRun = structuredClone(workspace.aiRun)
    const originalCandidates = structuredClone(workspace.candidates)
    const originalStartedAt = workspace.humanReview.startedAt
    assert.equal(annotationEditingEnabled(workspace.stage, true), false)

    const completedRollback = await request(baseUrl, rollbackPath, {
      method: 'POST', cookie,
      body: { targetStage: 'human_review_in_progress', reviewerName, baseRevision: completedRevision },
    })
    assert.equal(completedRollback.response.status, 200)
    workspace = completedRollback.body
    assert.equal(workspace.stage, 'human_review_in_progress')
    assert.equal(workspace.revision, completedRevision + 1)
    assert.deepEqual(workspace.candidates, originalCandidates)
    assert.deepEqual(workspace.aiRun, originalAiRun)
    assert.equal(workspace.humanReview.status, 'in_progress')
    assert.equal(workspace.humanReview.reviewerName, reviewerName)
    assert.equal(workspace.humanReview.startedAt, originalStartedAt)
    assert.equal(Object.hasOwn(workspace.humanReview, 'completedAt'), false)
    assert.equal(annotationEditingEnabled(workspace.stage, true), true)

    const proofreadingAfterCompletedRollback = await app.proofreadingService.getChapter(documentId, chapter.id)
    assert.deepEqual(proofreadingAfterCompletedRollback, savedProofreading)
    assert.equal(proofreadingAfterCompletedRollback.issues[0].id, 'manual-issue')
    assert.equal(proofreadingAfterCompletedRollback.annotations[0].id, 'manual-annotation')

    const staleRollback = await request(baseUrl, rollbackPath, {
      method: 'POST', cookie,
      body: { targetStage: 'awaiting_human_review', reviewerName, baseRevision: completedRevision },
    })
    assert.equal(staleRollback.response.status, 409)
    assert.equal(staleRollback.body.error, 'ai_review_revision_conflict')

    const invalidRollback = await request(baseUrl, rollbackPath, {
      method: 'POST', cookie,
      body: { targetStage: 'human_review_in_progress', reviewerName, baseRevision: workspace.revision },
    })
    assert.equal(invalidRollback.response.status, 409)
    assert.equal(invalidRollback.body.error, 'invalid_ai_review_transition')

    const awaitingRollback = await request(baseUrl, rollbackPath, {
      method: 'POST', cookie,
      body: { targetStage: 'awaiting_human_review', reviewerName, baseRevision: workspace.revision },
    })
    assert.equal(awaitingRollback.response.status, 200)
    workspace = awaitingRollback.body
    assert.equal(workspace.stage, 'awaiting_human_review')
    assert.equal(workspace.humanReview.status, 'not_started')
    assert.equal(workspace.humanReview.startedAt, originalStartedAt)
    assert.deepEqual(workspace.candidates, originalCandidates)
    assert.deepEqual(workspace.aiRun, originalAiRun)
    assert.deepEqual(await app.proofreadingService.getChapter(documentId, chapter.id), savedProofreading)

    assert.equal(annotationEditingEnabled('awaiting_ai', true), true)
    assert.equal(annotationEditingEnabled('awaiting_human_review', true), true)
    assert.equal(annotationEditingEnabled('human_review_in_progress', true), true)
    assert.equal(annotationEditingEnabled('completed', true), false)
    assert.equal(modelRequests, 0)
    assert.equal(retrievalRequests, 0)

    console.log('completed-to-human-review-in-progress=pass')
    console.log('rollback-preserves-candidate-resolutions=pass')
    console.log('rollback-preserves-manual-issues-and-annotations=pass')
    console.log('rollback-clears-completed-at-and-preserves-reviewer-start=pass')
    console.log('rollback-revision-conflict-and-invalid-transition=pass')
    console.log('human-review-to-awaiting-human-review=pass')
    console.log('annotation-editable-state-regression=pass')
    console.log('rollback-external-ai-and-retrieval-requests=0')
  } finally {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main()
