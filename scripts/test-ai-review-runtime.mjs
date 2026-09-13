#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'
import { SCREENING_SCHEMA, FINALIZATION_SCHEMA, AI_REVIEW_QUEUE_CONCURRENCY } from '../server/ai/aiReviewRuntimeService.mjs'
import { DeepSeekProviderError } from '../server/ai/deepseekResponsesClient.mjs'
import { validateCandidateIssue } from '../server/candidates/candidateContract.mjs'

const timestamp = '2026-09-13T00:00:00.000Z'
let testCount = 0
async function test(name, operation) { await operation(); testCount += 1; console.log(`${name}=pass`) }
function claimId(draftId, index = 0) { return `claim_${createHash('sha256').update(`${draftId}\n${index}`).digest('hex').slice(0, 16)}` }
function usage(seed) { return { input_tokens: seed, cached_tokens: 1, output_tokens: seed + 1, reasoning_tokens: 1, total_tokens: seed * 2 + 1 } }
function finding(overrides = {}) {
  return { draftId: 'draft-1', pdfPage: 1, blockId: 'block-1', originalText: '错误表述', issueType: 'wording', ruleType: 'static', severity: 'minor', extractionReliability: 'high', retrievalRequired: 'no', suggestionDraft: '正确表述', reasonDraft: '静态语言问题', retrievalClaims: [], ...overrides }
}
function finalDraft(overrides = {}) {
  return { draftId: 'draft-1', issueType: 'wording', ruleType: 'static', severity: 'minor', verificationStatus: 'not_required', retrievalRequired: 'no', judgement: 'confirmed_error', suggestion: '正确表述', reason: '静态语言问题', confidence: 'high', evidenceClaimIds: [], ...overrides }
}

class MockModelClient {
  constructor() { this.behaviors = new Map(); this.calls = []; this.active = 0; this.maxActive = 0 }
  getStatus() { return { configured: true, provider: 'deepseek', model: 'deepseek-v4-flash' } }
  async requestStructured(request) {
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active)
    try {
      const input = JSON.parse(request.input)
      const documentId = input.chapter.documentId
      const behavior = this.behaviors.get(documentId) ?? {}
      this.calls.push({ documentId, request, input })
      if (behavior.delay) await new Promise((resolve) => setTimeout(resolve, behavior.delay))
      if (request.reasoningEffort === 'low') {
        if (behavior.screeningError) throw behavior.screeningError
        return { data: { findings: structuredClone(behavior.findings ?? [finding()]) }, usage: usage(5) }
      }
      if (behavior.finalizationError) throw behavior.finalizationError
      const candidates = typeof behavior.candidates === 'function' ? behavior.candidates(input) : (behavior.candidates ?? [finalDraft()])
      return { data: { candidates: structuredClone(candidates) }, usage: usage(9) }
    } finally { this.active -= 1 }
  }
}

class MockRetrievalAdapter {
  constructor() { this.calls = []; this.active = 0; this.maxActive = 0 }
  async retrieve(claim) {
    this.calls.push(structuredClone(claim)); this.active += 1; this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((resolve) => setTimeout(resolve, 2)); this.active -= 1
    if (claim.text.includes('NOT_FOUND')) return { status: 'not_found', provider: 'yuandian-law', claimId: claim.claimId, evidence: [], warnings: [] }
    if (claim.text.includes('FOUND')) return { status: 'evidence_found', provider: 'yuandian-law', claimId: claim.claimId, evidence: [{ sourceType: 'law', authorityAxis: 'normative', title: '中华人民共和国示例法', supports: '支持核验命题' }], provenance: { providerTool: 'mock' }, warnings: [] }
    if (claim.text.includes('UNAVAILABLE')) return { status: 'provider_unavailable', provider: 'yuandian-law', claimId: claim.claimId, evidence: [], warnings: [] }
    return { status: 'insufficient_evidence', provider: 'yuandian-law', claimId: claim.claimId, evidence: [], warnings: ['insufficient_fields'] }
  }
  async close() {}
}

async function listen(app) {
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${app.server.address().port}`
}
async function request(base, route, options) { const response = await fetch(`${base}${route}`, options); const text = await response.text(); return { response, body: text ? JSON.parse(text) : null } }
function post(body, cookie) { return { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) } }

async function fixture(app, documentId, pages = [{ classification: 'native_ready', status: 'ready', text: '这里有错误表述，需要校对。', blockId: 'block-1' }]) {
  const pdf = Buffer.from(`%PDF-1.4\n% ${documentId}\n%%EOF\n`)
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  const asset = await app.documentStorage.storeOriginalPdf({ documentId, byteSize: pdf.length, sha256, content: [pdf] })
  await app.documentRepository.saveBundle({ document: { id: documentId, title: 'Synthetic fixture', originalAssetId: asset.id, pageCount: pages.length, processingStatus: 'ready', createdAt: timestamp, updatedAt: timestamp }, asset, pages: pages.map((_, index) => ({ id: `${documentId}-page-${index + 1}`, documentId, pdfPage: index + 1 })) })
  const chapter = await app.chapterService.create(documentId, { title: 'Synthetic chapter', order: 1, startPdfPage: 1, endPdfPage: pages.length, assigneeName: 'Reviewer', status: 'in_progress' })
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]
    await app.textRepository.writePage({ documentId, pdfPage: index + 1, source: page.classification === 'ocr_not_needed' ? 'none' : 'pdf_text', status: page.status, classification: page.classification, charCount: page.text?.length ?? 0, quality: { usable: Boolean(page.text), flags: [] }, coordinateSystem: null, blocks: page.text ? [{ id: page.blockId ?? `block-${index + 1}`, documentId, pdfPage: index + 1, order: 1, type: 'paragraph', text: page.text, source: 'pdf_text' }] : [], updatedAt: timestamp })
  }
  return chapter
}

const root = await mkdtemp(path.join(tmpdir(), 'ai-review-runtime-'))
const model = new MockModelClient()
const retrieval = new MockRetrievalAdapter()
const logs = []
const app = await createIngestionServer({ storageRoot: root, authRequired: false, modelClient: model, retrievalAdapter: retrieval, runtimeLogger: { error: (entry) => logs.push(entry) } })
const base = await listen(app)
try {
  const chapter = await fixture(app, 'happy-document', [
    { classification: 'native_ready', status: 'ready', text: '这里有错误表述，需要校对。', blockId: 'block-1' },
    { classification: 'native_suspicious', status: 'suspicious', text: '可疑提取文本。', blockId: 'block-2' },
    { classification: 'ocr_not_needed', status: 'ready', text: '', blockId: 'block-3' },
  ])
  const route = `/api/documents/happy-document/chapters/${chapter.id}/ai-review`
  await test('runtime-status-authenticated-shape', async () => { const result = await request(base, '/api/ai-runtime/status'); assert.deepEqual(result.body, { configured: true, provider: 'deepseek', model: 'deepseek-v4-flash' }) })
  await test('runtime-status-hides-secret-and-base-url', async () => { const result = await request(base, '/api/ai-runtime/status'); assert.equal(JSON.stringify(result.body).includes('key'), false); assert.equal('baseUrl' in result.body, false) })
  let startResult
  await test('awaiting-ai-start-returns-202', async () => { startResult = await request(base, `${route}/run`, post({ baseRevision: 0 })); assert.equal(startResult.response.status, 202); assert.equal(startResult.body.stage, 'ai_running') })
  await app.aiReviewRuntimeService.waitForIdle()
  const happy = await app.aiReviewService.get('happy-document', chapter.id)
  await test('job-completes-awaiting-human-review', () => assert.equal(happy.stage, 'awaiting_human_review'))
  const lowCall = model.calls.find((call) => call.documentId === 'happy-document' && call.request.reasoningEffort === 'low')
  const highCall = model.calls.find((call) => call.documentId === 'happy-document' && call.request.reasoningEffort === 'high')
  await test('stage1-receives-full-chapter-bundle', () => assert.equal(lowCall.input.chapter.pages.length, 3))
  await test('stage1-effort-low', () => assert.equal(lowCall.request.reasoningEffort, 'low'))
  await test('stage2-effort-high', () => assert.equal(highCall.request.reasoningEffort, 'high'))
  await test('stage1-json-schema-bounded', () => assert.equal(SCREENING_SCHEMA.properties.findings.maxItems, 100))
  await test('stage2-json-schema-bounded', () => assert.equal(FINALIZATION_SCHEMA.properties.candidates.maxItems, 100))
  await test('queue-concurrency-one-contract', () => assert.equal(AI_REVIEW_QUEUE_CONCURRENCY, 1))
  await test('candidate-id-server-generated', () => assert.match(happy.candidates[0].candidate.id, /^ltp_[a-f0-9]{16}$/))
  await test('human-resolution-pending', () => assert.equal(happy.candidates[0].candidate.humanResolution, 'pending'))
  await test('candidate-validates', () => assert.deepEqual(validateCandidateIssue(happy.candidates[0].candidate), []))
  await test('server-owned-location', () => { assert.equal(happy.candidates[0].candidate.documentId, 'happy-document'); assert.equal(happy.candidates[0].candidate.chapterId, chapter.id); assert.equal(happy.candidates[0].candidate.blockId, 'block-1') })
  await test('partial-coverage-retained', () => assert.deepEqual(happy.aiRun.coverage, { totalPages: 3, readyPages: 1, suspiciousPages: 1, unavailablePages: 0, blankPages: 1, coveredTextPages: 2, complete: false }))
  await test('usage-metadata-stored', () => assert.equal(happy.aiRun.usage.total.total_tokens, usage(5).total_tokens + usage(9).total_tokens))
  await test('skill-hash-stored', () => assert.match(happy.aiRun.skillHash, /^[a-f0-9]{64}$/))
  await test('raw-reasoning-not-stored', () => assert.equal(JSON.stringify(happy).includes('private reasoning'), false))
  await test('prompt-not-stored', () => assert.equal(JSON.stringify(happy).includes('Runtime rules'), false))
  await test('raw-provider-response-not-stored', () => assert.equal('output' in happy.aiRun, false))
  await test('no-auto-chapter-completion', async () => assert.equal((await app.documentRepository.getChapter('happy-document', chapter.id)).status, 'in_progress'))

  const retrievalChapter = await fixture(app, 'retrieval-document')
  model.behaviors.set('retrieval-document', {
    findings: [
      finding({ draftId: 'found', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [{ kind: 'article_text', text: 'FOUND', knownSourceTitle: '示例法', knownArticleNumber: '第一条' }] }),
      finding({ draftId: 'not-found', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [{ kind: 'article_text', text: 'NOT_FOUND' }] }),
      finding({ draftId: 'insufficient', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [{ kind: 'article_text', text: 'INSUFFICIENT' }] }),
      finding({ draftId: 'unavailable', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [{ kind: 'article_text', text: 'UNAVAILABLE' }] }),
    ],
    candidates: (input) => [{ ...finalDraft({ draftId: 'found', ruleType: 'verify', issueType: 'article_number', verificationStatus: 'verified', retrievalRequired: 'must', judgement: 'confirmed_error', evidenceClaimIds: [claimId('found')] }) }],
  })
  const retrievalStart = await app.aiReviewService.startAiRun('retrieval-document', retrievalChapter.id, 0); app.aiReviewRuntimeService.enqueue('retrieval-document', retrievalChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const retrievalWorkspace = await app.aiReviewService.get('retrieval-document', retrievalChapter.id)
  const retrievalHigh = model.calls.find((call) => call.documentId === 'retrieval-document' && call.request.reasoningEffort === 'high')
  await test('claim-id-server-generated', () => assert.equal(retrieval.calls.find((claim) => claim.text === 'FOUND').claimId, claimId('found')))
  await test('claim-location-server-injected', () => { const claim = retrieval.calls[0]; assert.equal(claim.documentId, 'retrieval-document'); assert.equal(claim.chapterId, retrievalChapter.id); assert.equal(claim.pdfPage, 1) })
  await test('yuandian-invoked-by-server', () => assert.equal(retrieval.calls.length >= 4, true))
  await test('evidence-found-passed-stage2', () => assert.equal(retrievalHigh.input.retrievalResults.some((result) => result.status === 'evidence_found'), true))
  await test('not-found-passed-stage2', () => assert.equal(retrievalHigh.input.retrievalResults.some((result) => result.status === 'not_found'), true))
  await test('insufficient-passed-stage2', () => assert.equal(retrievalHigh.input.retrievalResults.some((result) => result.status === 'insufficient_evidence'), true))
  await test('provider-unavailable-does-not-fail', () => assert.equal(retrievalWorkspace.stage, 'awaiting_human_review'))
  await test('evidence-copied-from-normalized-result', () => assert.deepEqual(retrievalWorkspace.candidates[0].candidate.evidence, retrievalHigh.input.retrievalResults[0].evidence))
  await test('retrieval-counts-stored', () => { assert.equal(retrievalWorkspace.aiRun.retrievalClaimCount, 4); assert.equal(retrievalWorkspace.aiRun.evidenceFoundCount, 1) })
  await test('retrieval-concurrency-bounded-three', () => assert.equal(retrieval.maxActive <= 3, true))

  async function failureCase(documentId, behavior, expectedCode, pages) {
    const caseChapter = await fixture(app, documentId, pages)
    model.behaviors.set(documentId, behavior)
    const running = await app.aiReviewService.startAiRun(documentId, caseChapter.id, 0)
    assert.equal(running.stage, 'ai_running')
    app.aiReviewRuntimeService.enqueue(documentId, caseChapter.id)
    await app.aiReviewRuntimeService.waitForIdle()
    const workspace = await app.aiReviewService.get(documentId, caseChapter.id)
    assert.equal(workspace.stage, 'ai_failed'); assert.equal(workspace.aiRun.errorCode, expectedCode)
    return { caseChapter, workspace }
  }
  await test('hallucinated-original-text-rejected', () => failureCase('hallucination-document', { findings: [finding({ originalText: '不存在的原文' })] }, 'deepseek_output_invalid'))
  await test('block-id-mismatch-rejected', () => failureCase('block-mismatch-document', { findings: [finding({ blockId: 'invented-block' })] }, 'deepseek_output_invalid'))
  await test('page-outside-chapter-rejected', () => failureCase('page-outside-document', { findings: [finding({ pdfPage: 2 })] }, 'deepseek_output_invalid'))
  await test('controlled-enum-enforced', () => failureCase('enum-document', { findings: [finding({ severity: 'catastrophic' })] }, 'deepseek_output_invalid'))
  await test('unknown-evidence-claim-rejected', () => failureCase('unknown-evidence-document', { candidates: [finalDraft({ evidenceClaimIds: ['invented-claim'] })] }, 'deepseek_output_invalid'))
  await test('model-candidate-id-field-rejected', () => failureCase('model-id-document', { candidates: [finalDraft({ id: 'model-controlled' })] }, 'deepseek_output_invalid'))
  await test('model-full-evidence-field-rejected', () => failureCase('model-evidence-document', { candidates: [finalDraft({ evidence: [{ title: 'invented' }] })] }, 'deepseek_output_invalid'))
  await test('invalid-candidate-fails-whole-run', () => failureCase('invalid-candidate-document', { candidates: [finalDraft({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'unverified', judgement: 'confirmed_error' })] }, 'candidate_validation_failed'))
  await test('deepseek-failure-becomes-ai-failed', () => failureCase('provider-failure-document', { screeningError: new DeepSeekProviderError('deepseek_rate_limited', { status: 429 }) }, 'deepseek_rate_limited'))
  await test('no-text-fails-before-model', async () => { const before = model.calls.length; await failureCase('no-text-document', {}, 'chapter_text_unavailable', [{ classification: 'ocr_required', status: 'ocr_required', text: '' }]); assert.equal(model.calls.length, before) })
  await test('large-chapter-fails-without-truncation', async () => { const previous = app.aiReviewRuntimeService.maxChapterChars; app.aiReviewRuntimeService.maxChapterChars = 5; try { await failureCase('large-document', {}, 'chapter_text_too_large') } finally { app.aiReviewRuntimeService.maxChapterChars = previous } })

  const emptyChapter = await fixture(app, 'empty-final-document'); model.behaviors.set('empty-final-document', { candidates: [] })
  await app.aiReviewService.startAiRun('empty-final-document', emptyChapter.id, 0); app.aiReviewRuntimeService.enqueue('empty-final-document', emptyChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const emptyWorkspace = await app.aiReviewService.get('empty-final-document', emptyChapter.id)
  await test('empty-final-candidates-valid', () => assert.equal(emptyWorkspace.candidates.length, 0))
  await test('zero-candidates-await-human-review', () => assert.equal(emptyWorkspace.stage, 'awaiting_human_review'))

  const duplicateChapter = await fixture(app, 'duplicate-document'); model.behaviors.set('duplicate-document', { candidates: [finalDraft(), finalDraft()] })
  await app.aiReviewService.startAiRun('duplicate-document', duplicateChapter.id, 0); app.aiReviewRuntimeService.enqueue('duplicate-document', duplicateChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  await test('identical-duplicate-collapsed', async () => assert.equal((await app.aiReviewService.get('duplicate-document', duplicateChapter.id)).candidates.length, 1))
  await test('conflicting-duplicate-fails', () => failureCase('duplicate-conflict-document', { candidates: [finalDraft(), finalDraft({ suggestion: '另一建议' })] }, 'candidate_validation_failed'))

  const retryChapter = await fixture(app, 'retry-document'); model.behaviors.set('retry-document', { screeningError: new DeepSeekProviderError('deepseek_timeout') })
  let retryWorkspace = await app.aiReviewService.startAiRun('retry-document', retryChapter.id, 0); app.aiReviewRuntimeService.enqueue('retry-document', retryChapter.id); await app.aiReviewRuntimeService.waitForIdle(); retryWorkspace = await app.aiReviewService.get('retry-document', retryChapter.id)
  const callsAfterFailure = model.calls.filter((call) => call.documentId === 'retry-document').length
  await test('no-automatic-model-retry', () => assert.equal(callsAfterFailure, 1))
  model.behaviors.set('retry-document', {}); const retryResponse = await request(base, `/api/documents/retry-document/chapters/${retryChapter.id}/ai-review/run`, post({ baseRevision: retryWorkspace.revision })); await app.aiReviewRuntimeService.waitForIdle()
  await test('explicit-retry-accepted', () => assert.equal(retryResponse.response.status, 202))
  await test('explicit-retry-completes', async () => assert.equal((await app.aiReviewService.get('retry-document', retryChapter.id)).stage, 'awaiting_human_review'))

  const concurrentOne = await fixture(app, 'queue-one'); const concurrentTwo = await fixture(app, 'queue-two'); model.behaviors.set('queue-one', { delay: 10 }); model.behaviors.set('queue-two', { delay: 10 })
  await app.aiReviewService.startAiRun('queue-one', concurrentOne.id, 0); await app.aiReviewService.startAiRun('queue-two', concurrentTwo.id, 0); app.aiReviewRuntimeService.enqueue('queue-one', concurrentOne.id); app.aiReviewRuntimeService.enqueue('queue-two', concurrentTwo.id); await app.aiReviewRuntimeService.waitForIdle()
  await test('queue-executes-jobs-serially', () => assert.equal(model.maxActive, 1))

  const duplicateRunChapter = await fixture(app, 'duplicate-run'); model.behaviors.set('duplicate-run', { delay: 20 })
  const duplicateRoute = `/api/documents/duplicate-run/chapters/${duplicateRunChapter.id}/ai-review/run`; const firstRun = await request(base, duplicateRoute, post({ baseRevision: 0 })); const secondRun = await request(base, duplicateRoute, post({ baseRevision: 0 })); await app.aiReviewRuntimeService.waitForIdle()
  await test('duplicate-concurrent-run-blocked', () => { assert.equal(firstRun.response.status, 202); assert.equal(secondRun.response.status, 409) })

  const interruptedChapter = await fixture(app, 'interrupted-document'); await app.aiReviewService.startAiRun('interrupted-document', interruptedChapter.id, 0); await app.aiReviewRuntimeService.init()
  await test('restart-recovery-marks-interrupted', async () => { const workspace = await app.aiReviewService.get('interrupted-document', interruptedChapter.id); assert.equal(workspace.stage, 'ai_failed'); assert.equal(workspace.aiRun.errorCode, 'runtime_interrupted') })

  const manualChapter = await fixture(app, 'manual-document'); const manualBefore = await app.proofreadingService.saveChapter('manual-document', manualChapter.id, { baseRevision: 0, annotations: [], issues: [] })
  model.behaviors.set('manual-document', { screeningError: new DeepSeekProviderError('deepseek_timeout') }); await app.aiReviewService.startAiRun('manual-document', manualChapter.id, 0); app.aiReviewRuntimeService.enqueue('manual-document', manualChapter.id); await app.aiReviewRuntimeService.waitForIdle(); const manualAfter = await app.proofreadingService.getChapter('manual-document', manualChapter.id)
  await test('manual-proofreading-workspace-untouched', () => assert.deepEqual(manualAfter, manualBefore))
  await test('sanitized-logs-only', () => { const serialized = JSON.stringify(logs); assert.equal(serialized.includes('这里有错误表述'), false); assert.equal(serialized.includes('apiKey'), false); assert.equal(logs.every((entry) => entry.provider === 'deepseek' && entry.model === 'deepseek-v4-flash'), true) })
  await test('systemd-deepseek-env-optional', async () => assert.equal((await readFile(path.resolve('ops/systemd/textbook-proofreading-api.service'), 'utf8')).includes('EnvironmentFile=-/etc/textbook-proofreading/deepseek.env'), true))
} finally {
  await app.close(); await rm(root, { recursive: true, force: true })
}

const authRoot = await mkdtemp(path.join(tmpdir(), 'ai-review-runtime-auth-'))
const authApp = await createIngestionServer({ storageRoot: authRoot, authRequired: true, accessUsername: 'user', accessPassword: 'secret', modelClient: new MockModelClient(), retrievalAdapter: new MockRetrievalAdapter(), runtimeLogger: { error() {} } })
const authBase = await listen(authApp)
try {
  await test('run-endpoint-requires-authentication', async () => { const result = await request(authBase, '/api/documents/a/chapters/b/ai-review/run', post({ baseRevision: 0 })); assert.equal(result.response.status, 401) })
  await test('status-endpoint-requires-authentication', async () => { const result = await request(authBase, '/api/ai-runtime/status'); assert.equal(result.response.status, 401) })
} finally { await authApp.close(); await rm(authRoot, { recursive: true, force: true }) }

assert.equal(testCount >= 45, true)
console.log(`ai-review-runtime-test-count=${testCount}`)
console.log('real-deepseek-requests=0')
