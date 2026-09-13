#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CANDIDATE_SCHEMA_PATH,
  stableCandidateId,
  validateCandidateIssue,
} from '../server/candidates/candidateContract.mjs'
import { AI_REVIEW_STAGES } from '../server/services/aiChapterReviewService.mjs'
import { createIngestionServer } from '../server/app.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'
const reviewerName = 'Responsible Reviewer'
let fixtureSequence = 0
let testCount = 0

function fixtureDocument(id) {
  return {
    id,
    title: `AI review fixture ${id}`,
    originalAssetId: '',
    pageCount: 20,
    processingStatus: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function manualWorkspace(baseRevision, suffix) {
  const annotationId = `manual-annotation-${suffix}`
  return {
    baseRevision,
    annotations: [{ id: annotationId, kind: 'highlight', payload: { selectedText: suffix } }],
    issues: [{
      id: `manual-issue-${suffix}`,
      annotationId,
      pdfPage: 2,
      printedPage: '',
      originalText: `manual original ${suffix}`,
      category: 'typo',
      suggestion: `manual suggestion ${suffix}`,
      reason: '',
      status: 'pending',
      reviewer: reviewerName,
      verifier: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }
}

function candidate(documentId, chapterId, suffix, overrides = {}) {
  const value = {
    schemaVersion: '0.1',
    id: '',
    documentId,
    chapterId,
    pdfPage: 2,
    blockId: `block-${suffix}`,
    originalText: `Synthetic candidate text ${suffix}`,
    issueType: 'typo',
    ruleType: 'static',
    severity: 'minor',
    extractionReliability: 'high',
    verificationStatus: 'not_required',
    retrievalRequired: 'no',
    evidence: [],
    judgement: 'confirmed_error',
    suggestion: `Synthetic suggestion ${suffix}`,
    reason: `Synthetic reason ${suffix}`,
    confidence: 'high',
    humanResolution: 'pending',
    ...overrides,
  }
  value.id = stableCandidateId(value)
  if (overrides.id !== undefined) value.id = overrides.id
  return value
}

async function expectError(operation, code, statusCode) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code)
    if (statusCode !== undefined) assert.equal(error?.statusCode, statusCode)
    return true
  })
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function request(baseUrl, route, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

async function runTest(name, operation) {
  await operation()
  testCount += 1
  console.log(`${name}=pass`)
}

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'textbook-ai-review-'))
  const fixedNow = () => new Date(timestamp)
  const app = await createIngestionServer({ storageRoot })
  app.aiReviewRepository.now = fixedNow
  app.aiReviewService.now = fixedNow
  const baseUrl = await listen(app)

  async function createFixture({ assigned = true } = {}) {
    fixtureSequence += 1
    const documentId = `ai-review-document-${fixtureSequence}`
    await app.documentRepository.saveBundle({
      document: fixtureDocument(documentId),
      asset: null,
      pages: [],
    })
    const chapter = await app.chapterService.create(documentId, {
      title: `Chapter ${fixtureSequence}`,
      order: 1,
      startPdfPage: 1,
      endPdfPage: 10,
      status: 'not_started',
      ...(assigned ? { assigneeName: reviewerName } : {}),
    })
    return { documentId, chapter }
  }

  async function runningFixture() {
    const context = await createFixture()
    context.workspace = await app.aiReviewService.startAiRun(
      context.documentId,
      context.chapter.id,
      0,
    )
    return context
  }

  async function awaitingHumanFixture({ candidates = null } = {}) {
    const context = await runningFixture()
    const values = candidates ?? [candidate(context.documentId, context.chapter.id, fixtureSequence)]
    context.workspace = await app.aiReviewService.completeAiRun(
      context.documentId,
      context.chapter.id,
      values,
      context.workspace.revision,
    )
    return context
  }

  async function humanReviewFixture({ candidates = null } = {}) {
    const context = await awaitingHumanFixture({ candidates })
    context.workspace = await app.aiReviewService.startHumanReview(
      context.documentId,
      context.chapter.id,
      reviewerName,
      context.workspace.revision,
    )
    return context
  }

  try {
    const initial = await createFixture()
    const initialRoute = `/api/documents/${initial.documentId}/chapters/${initial.chapter.id}/ai-review`

    await runTest('missing-workspace-awaiting-ai', async () => {
      const result = await request(baseUrl, initialRoute)
      assert.equal(result.response.status, 200)
      assert.equal(result.body.schemaVersion, 1)
      assert.equal(result.body.revision, 0)
      assert.equal(result.body.stage, 'awaiting_ai')
      assert.deepEqual(result.body.candidates, [])
    })

    await runTest('get-does-not-create-workspace', async () => {
      const recordPath = app.aiReviewRepository.recordPath(initial.documentId, initial.chapter.id)
      await assert.rejects(stat(recordPath), (error) => error?.code === 'ENOENT')
      assert.throws(() => app.aiReviewRepository.recordPath('../escape', initial.chapter.id))
    })

    await runTest('document-summary-includes-empty-workspace-without-writing', async () => {
      const result = await request(baseUrl, `/api/documents/${initial.documentId}/ai-reviews`)
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body, {
        documentId: initial.documentId,
        reviews: [{ chapterId: initial.chapter.id, stage: 'awaiting_ai', candidateCount: 0, pendingCount: 0 }],
      })
      await assert.rejects(
        stat(app.aiReviewRepository.recordPath(initial.documentId, initial.chapter.id)),
        (error) => error?.code === 'ENOENT',
      )
    })

    await runTest('awaiting-ai-to-ai-running', async () => {
      initial.workspace = await app.aiReviewService.startAiRun(initial.documentId, initial.chapter.id, 0)
      assert.equal(initial.workspace.stage, 'ai_running')
      assert.equal(initial.workspace.aiRun.status, 'running')
    })

    await runTest('ai-running-to-awaiting-human-review', async () => {
      const value = candidate(initial.documentId, initial.chapter.id, 'initial')
      initial.workspace = await app.aiReviewService.completeAiRun(
        initial.documentId,
        initial.chapter.id,
        [value],
        initial.workspace.revision,
      )
      assert.equal(initial.workspace.stage, 'awaiting_human_review')
      assert.equal(initial.workspace.aiRun.status, 'completed')
    })

    await runTest('document-summary-reports-persisted-stage-and-counts', async () => {
      const result = await request(baseUrl, `/api/documents/${initial.documentId}/ai-reviews`)
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body.reviews, [{
        chapterId: initial.chapter.id,
        stage: 'awaiting_human_review',
        candidateCount: 1,
        pendingCount: 1,
      }])
    })

    const failed = await runningFixture()
    await runTest('ai-running-to-ai-failed', async () => {
      failed.workspace = await app.aiReviewService.failAiRun(
        failed.documentId,
        failed.chapter.id,
        'synthetic_failure',
        failed.workspace.revision,
      )
      assert.equal(failed.workspace.stage, 'ai_failed')
      assert.equal(failed.workspace.aiRun.errorCode, 'synthetic_failure')
    })

    await runTest('ai-failed-to-ai-running', async () => {
      failed.workspace = await app.aiReviewService.retryAiRun(
        failed.documentId,
        failed.chapter.id,
        failed.workspace.revision,
      )
      assert.equal(failed.workspace.stage, 'ai_running')
    })

    await runTest('invalid-transition-rejected', async () => {
      await expectError(
        app.aiReviewService.startAiRun(initial.documentId, initial.chapter.id, initial.workspace.revision),
        'invalid_ai_review_transition',
        409,
      )
    })

    const empty = await runningFixture()
    await runTest('ai-complete-accepts-empty-candidates', async () => {
      empty.workspace = await app.aiReviewService.completeAiRun(
        empty.documentId,
        empty.chapter.id,
        [],
        empty.workspace.revision,
      )
      assert.equal(empty.workspace.stage, 'awaiting_human_review')
      assert.deepEqual(empty.workspace.candidates, [])
    })

    await runTest('invalid-candidate-rejects-whole-batch', async () => {
      const context = await runningFixture()
      const valid = candidate(context.documentId, context.chapter.id, 'valid-before-invalid')
      const invalid = candidate(context.documentId, context.chapter.id, 'invalid')
      delete invalid.suggestion
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [valid, invalid],
          context.workspace.revision,
        ),
        'invalid_ai_candidate',
        400,
      )
      const persisted = await app.aiReviewService.get(context.documentId, context.chapter.id)
      assert.equal(persisted.stage, 'ai_running')
      assert.equal(persisted.revision, 1)
      assert.deepEqual(persisted.candidates, [])
      const unstableId = candidate(context.documentId, context.chapter.id, 'unstable-id', {
        id: 'ltp_0000000000000000',
      })
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [unstableId],
          persisted.revision,
        ),
        'invalid_ai_candidate',
        400,
      )
    })

    await runTest('wrong-document-candidate-rejected', async () => {
      const context = await runningFixture()
      const value = candidate('different-document', context.chapter.id, 'wrong-document')
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [value],
          context.workspace.revision,
        ),
        'candidate_document_mismatch',
        400,
      )
    })

    await runTest('wrong-chapter-candidate-rejected', async () => {
      const context = await runningFixture()
      const value = candidate(context.documentId, 'different-chapter', 'wrong-chapter')
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [value],
          context.workspace.revision,
        ),
        'candidate_chapter_mismatch',
        400,
      )
    })

    await runTest('outside-chapter-page-rejected', async () => {
      const context = await runningFixture()
      const value = candidate(context.documentId, context.chapter.id, 'outside-page', { pdfPage: 11 })
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [value],
          context.workspace.revision,
        ),
        'candidate_outside_chapter_range',
        400,
      )
    })

    await runTest('duplicate-candidate-id-rejected', async () => {
      const context = await runningFixture()
      const value = candidate(context.documentId, context.chapter.id, 'duplicate')
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [value, structuredClone(value)],
          context.workspace.revision,
        ),
        'duplicate_candidate_id',
        400,
      )
    })

    await runTest('original-human-resolution-must-be-pending', async () => {
      const context = await runningFixture()
      const value = candidate(context.documentId, context.chapter.id, 'pre-resolved', {
        humanResolution: 'accepted',
      })
      assert.ok(validateCandidateIssue(value).some((error) => error.includes('must remain pending')))
      await expectError(
        app.aiReviewService.completeAiRun(
          context.documentId,
          context.chapter.id,
          [value],
          context.workspace.revision,
        ),
        'invalid_ai_candidate',
        400,
      )
    })

    await runTest('accepted-resolution-preserves-original', async () => {
      const context = await humanReviewFixture()
      const original = structuredClone(context.workspace.candidates[0].candidate)
      const route = `/api/documents/${context.documentId}/chapters/${context.chapter.id}/ai-review/candidates/${original.id}/resolution`
      const result = await request(baseUrl, route, 'PUT', {
        baseRevision: context.workspace.revision,
        status: 'accepted',
        resolvedBy: reviewerName,
      })
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body.candidates[0].candidate, original)
      assert.equal(result.body.candidates[0].candidate.humanResolution, 'pending')
      assert.equal(result.body.candidates[0].resolution.status, 'accepted')
    })

    await runTest('rejected-candidate-retained', async () => {
      const context = await humanReviewFixture()
      const original = structuredClone(context.workspace.candidates[0].candidate)
      context.workspace = await app.aiReviewService.resolveCandidate(
        context.documentId,
        context.chapter.id,
        original.id,
        { status: 'rejected', resolvedBy: reviewerName },
        context.workspace.revision,
      )
      assert.equal(context.workspace.candidates.length, 1)
      assert.deepEqual(context.workspace.candidates[0].candidate, original)
      assert.equal(context.workspace.candidates[0].resolution.status, 'rejected')
    })

    await runTest('modified-resolution-preserves-original-and-result', async () => {
      const context = await humanReviewFixture()
      const original = structuredClone(context.workspace.candidates[0].candidate)
      const modifiedResult = {
        originalText: 'Human-corrected original text',
        issueType: 'wording',
        suggestion: 'Human-corrected suggestion',
        reason: 'Human-corrected reason',
        pdfPage: 3,
        printedPage: '1',
      }
      context.workspace = await app.aiReviewService.resolveCandidate(
        context.documentId,
        context.chapter.id,
        original.id,
        { status: 'modified', resolvedBy: reviewerName, modifiedResult },
        context.workspace.revision,
      )
      assert.deepEqual(context.workspace.candidates[0].candidate, original)
      assert.deepEqual(context.workspace.candidates[0].resolution.modifiedResult, modifiedResult)
    })

    await runTest('human-actions-must-match-assignee', async () => {
      const context = await awaitingHumanFixture()
      await expectError(
        app.aiReviewService.startHumanReview(
          context.documentId,
          context.chapter.id,
          'Different Reviewer',
          context.workspace.revision,
        ),
        'ai_review_reviewer_mismatch',
        409,
      )
      context.workspace = await app.aiReviewService.startHumanReview(
        context.documentId,
        context.chapter.id,
        reviewerName,
        context.workspace.revision,
      )
      await expectError(
        app.aiReviewService.resolveCandidate(
          context.documentId,
          context.chapter.id,
          context.workspace.candidates[0].candidate.id,
          { status: 'accepted', resolvedBy: 'Different Reviewer' },
          context.workspace.revision,
        ),
        'ai_review_reviewer_mismatch',
        409,
      )
      context.workspace = await app.aiReviewService.resolveCandidate(
        context.documentId,
        context.chapter.id,
        context.workspace.candidates[0].candidate.id,
        { status: 'accepted', resolvedBy: reviewerName },
        context.workspace.revision,
      )
      await expectError(
        app.aiReviewService.completeHumanReview(
          context.documentId,
          context.chapter.id,
          'Different Reviewer',
          context.workspace.revision,
        ),
        'ai_review_reviewer_mismatch',
        409,
      )
    })

    const explicit = await awaitingHumanFixture()
    const explicitRoute = `/api/documents/${explicit.documentId}/chapters/${explicit.chapter.id}/ai-review`
    await runTest('start-human-review-moves-stage', async () => {
      const result = await request(baseUrl, `${explicitRoute}/human-review/start`, 'POST', {
        baseRevision: explicit.workspace.revision,
        reviewerName,
      })
      assert.equal(result.response.status, 200)
      explicit.workspace = result.body
      assert.equal(explicit.workspace.stage, 'human_review_in_progress')
      assert.equal(explicit.workspace.humanReview.reviewerName, reviewerName)
    })

    await runTest('pending-candidate-blocks-completion', async () => {
      const result = await request(baseUrl, `${explicitRoute}/human-review/complete`, 'POST', {
        baseRevision: explicit.workspace.revision,
        reviewerName,
      })
      assert.equal(result.response.status, 409)
      assert.equal(result.body.error, 'pending_ai_candidates')
    })

    await runTest('all-resolved-does-not-auto-complete', async () => {
      explicit.workspace = await app.aiReviewService.resolveCandidate(
        explicit.documentId,
        explicit.chapter.id,
        explicit.workspace.candidates[0].candidate.id,
        { status: 'accepted', resolvedBy: reviewerName },
        explicit.workspace.revision,
      )
      assert.equal(explicit.workspace.candidates[0].resolution.status, 'accepted')
      assert.equal(explicit.workspace.stage, 'human_review_in_progress')
    })

    await runTest('explicit-human-complete-enters-completed', async () => {
      const result = await request(baseUrl, `${explicitRoute}/human-review/complete`, 'POST', {
        baseRevision: explicit.workspace.revision,
        reviewerName,
      })
      assert.equal(result.response.status, 200)
      explicit.workspace = result.body
      assert.equal(explicit.workspace.stage, 'completed')
      assert.equal(explicit.workspace.humanReview.status, 'completed')
    })

    await runTest('zero-candidate-chapter-can-complete-explicitly', async () => {
      empty.workspace = await app.aiReviewService.startHumanReview(
        empty.documentId,
        empty.chapter.id,
        reviewerName,
        empty.workspace.revision,
      )
      empty.workspace = await app.aiReviewService.completeHumanReview(
        empty.documentId,
        empty.chapter.id,
        reviewerName,
        empty.workspace.revision,
      )
      assert.equal(empty.workspace.stage, 'completed')
    })

    await runTest('completed-chapter-cannot-reopen', async () => {
      await expectError(
        app.aiReviewService.startHumanReview(
          explicit.documentId,
          explicit.chapter.id,
          reviewerName,
          explicit.workspace.revision,
        ),
        'invalid_ai_review_transition',
        409,
      )
    })

    await runTest('ai-rerun-after-human-review-blocked', async () => {
      const context = await humanReviewFixture()
      await expectError(
        app.aiReviewService.retryAiRun(
          context.documentId,
          context.chapter.id,
          context.workspace.revision,
        ),
        'ai_review_rerun_conflict',
        409,
      )
    })

    await runTest('ai-rerun-after-resolution-blocked', async () => {
      const context = await humanReviewFixture()
      context.workspace = await app.aiReviewService.resolveCandidate(
        context.documentId,
        context.chapter.id,
        context.workspace.candidates[0].candidate.id,
        { status: 'rejected', resolvedBy: reviewerName },
        context.workspace.revision,
      )
      await expectError(
        app.aiReviewService.retryAiRun(
          context.documentId,
          context.chapter.id,
          context.workspace.revision,
        ),
        'ai_review_rerun_conflict',
        409,
      )
    })

    await runTest('independent-ai-review-revision-conflict', async () => {
      const context = await awaitingHumanFixture()
      await expectError(
        app.aiReviewService.startHumanReview(
          context.documentId,
          context.chapter.id,
          reviewerName,
          context.workspace.revision - 1,
        ),
        'ai_review_revision_conflict',
        409,
      )
    })

    const independent = await createFixture()
    const manualBefore = await app.proofreadingService.saveChapter(
      independent.documentId,
      independent.chapter.id,
      manualWorkspace(0, 'independent'),
    )
    let independentAi = await app.aiReviewService.startAiRun(
      independent.documentId,
      independent.chapter.id,
      0,
    )
    independentAi = await app.aiReviewService.completeAiRun(
      independent.documentId,
      independent.chapter.id,
      [candidate(independent.documentId, independent.chapter.id, 'independent')],
      independentAi.revision,
    )
    independentAi = await app.aiReviewService.startHumanReview(
      independent.documentId,
      independent.chapter.id,
      reviewerName,
      independentAi.revision,
    )
    independentAi = await app.aiReviewService.resolveCandidate(
      independent.documentId,
      independent.chapter.id,
      independentAi.candidates[0].candidate.id,
      { status: 'accepted', resolvedBy: reviewerName },
      independentAi.revision,
    )
    const manualAfter = await app.proofreadingService.getChapter(
      independent.documentId,
      independent.chapter.id,
    )

    await runTest('proofreading-revision-untouched', async () => {
      assert.equal(manualBefore.revision, 1)
      assert.equal(manualAfter.revision, manualBefore.revision)
      assert.equal(independentAi.revision, 4)
    })

    await runTest('manual-proofreading-issues-untouched', async () => {
      assert.deepEqual(manualAfter.issues, manualBefore.issues)
      assert.equal(manualAfter.issues.length, 1)
      const chapter = await app.documentRepository.getChapter(independent.documentId, independent.chapter.id)
      assert.equal(chapter.status, 'not_started')
      assert.equal(chapter.assigneeName, reviewerName)
    })

    await runTest('document-deletion-removes-ai-review', async () => {
      const context = await runningFixture()
      const directory = app.aiReviewRepository.documentDirectory(context.documentId)
      assert.equal((await stat(directory)).isDirectory(), true)
      await app.documentDeletionService.delete(context.documentId)
      await assert.rejects(stat(directory), (error) => error?.code === 'ENOENT')
      await expectError(
        app.aiReviewService.get(context.documentId, context.chapter.id),
        'document_not_found',
        404,
      )
    })

    await runTest('candidate-schema-remains-v0-1', async () => {
      const schema = JSON.parse(await readFile(CANDIDATE_SCHEMA_PATH, 'utf8'))
      assert.equal(schema.$id.endsWith('issue-v0.1.schema.json'), true)
      assert.equal(schema.properties.schemaVersion.const, '0.1')
      assert.deepEqual(schema.properties.humanResolution.enum, [
        'pending', 'accepted', 'modified', 'rejected',
      ])
      assert.equal(schema.description.includes('not a final erratum'), true)
    })

    await runTest('ai-workflow-makes-no-provider-or-llm-call', async () => {
      const context = await createFixture()
      const originalFetch = globalThis.fetch
      let externalCalls = 0
      globalThis.fetch = async () => {
        externalCalls += 1
        throw new Error('unexpected external call')
      }
      try {
        let workspace = await app.aiReviewService.startAiRun(context.documentId, context.chapter.id, 0)
        workspace = await app.aiReviewService.failAiRun(
          context.documentId,
          context.chapter.id,
          'offline_test',
          workspace.revision,
        )
        assert.equal(workspace.stage, 'ai_failed')
      } finally {
        globalThis.fetch = originalFetch
      }
      assert.equal(externalCalls, 0)
    })

    assert.deepEqual(AI_REVIEW_STAGES, [
      'awaiting_ai',
      'ai_running',
      'awaiting_human_review',
      'human_review_in_progress',
      'completed',
      'ai_failed',
    ])
    assert.equal(testCount, 34)
    console.log(`ai-review-workflow-test-count=${testCount}`)
    console.log('llm-provider-calls=0')
  } finally {
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  }
}

await main()
