#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'
import {
  AI_REVIEW_QUEUE_CONCURRENCY,
  applyConservativeCandidatePolicy,
  assertFinalShape,
  assertScreeningShape,
  CANDIDATE_POLICY_NORMALIZATION_CATEGORIES,
  hydrateFindingLocation,
  locationGate,
  MAX_CANDIDATES,
  MAX_CLAIMS_PER_FINDING,
  MAX_FINDINGS,
  MAX_RETRIEVAL_CLAIMS,
  normalizeFinalizationTransport,
  normalizeScreeningTransport,
  finalizationInstructions,
  screeningInstructions,
} from '../server/ai/aiReviewRuntimeService.mjs'
import {
  FINALIZATION_TRANSPORT_SCHEMA,
  SCREENING_TRANSPORT_SCHEMA,
} from '../server/ai/deepseekTransportSchemas.mjs'
import { DeepSeekProviderError } from '../server/ai/deepseekResponsesClient.mjs'
import { candidateInvariantErrors, stableCandidateId, validateCandidateIssue } from '../server/candidates/candidateContract.mjs'
import { validateRetrievalClaim } from '../server/retrieval/types.mjs'

const timestamp = '2026-09-13T00:00:00.000Z'
let testCount = 0
async function test(name, operation) { await operation(); testCount += 1; console.log(`${name}=pass`) }
function claimId(draftId, index = 0) { return `claim_${createHash('sha256').update(`${draftId}\n${index}`).digest('hex').slice(0, 16)}` }
function usage(seed) { return { input_tokens: seed, cached_tokens: 1, output_tokens: seed + 1, reasoning_tokens: 1, total_tokens: seed * 2 + 1 } }
function retrievalClaim(overrides = {}) {
  return { kind: 'article_text', text: 'FOUND', knownSourceTitle: '', knownArticleNumber: '', jurisdiction: '', referenceDate: '', ...overrides }
}
function finding(overrides = {}) {
  return { draftId: 'draft-1', pdfPage: 1, blockId: 'block-1', issueType: 'wording', ruleType: 'static', severity: 'minor', retrievalRequired: 'no', temporalContext: 'unspecified', disputeStatus: 'none', jurisdictionScope: '', suggestionDraft: '正确表述', reasonDraft: '静态语言问题', retrievalClaims: [], humanReviewNote: '', ...overrides }
}
function finalDraft(overrides = {}) {
  return { draftId: 'draft-1', verificationStatus: 'not_required', judgement: 'confirmed_error', suggestion: '正确表述', reason: '静态语言问题', confidence: 'high', temporalContext: 'unspecified', disputeStatus: 'none', jurisdictionScope: '', humanReviewNote: '', correctedText: '', evidenceClaimIds: [], ...overrides }
}
function policyCandidate(overrides = {}) {
  const candidate = { schemaVersion: '0.1', id: '', documentId: 'document', chapterId: 'chapter', pdfPage: 1, blockId: 'block-1', originalText: '合成候选文本', issueType: 'wording', ruleType: 'static', severity: 'minor', extractionReliability: 'high', verificationStatus: 'not_required', retrievalRequired: 'no', evidence: [], judgement: 'confirmed_error', suggestion: '正确表述', reason: '合成测试原因', confidence: 'high', temporalContext: 'unspecified', disputeStatus: 'none', humanResolution: 'pending', ...overrides }
  candidate.id = stableCandidateId(candidate)
  return candidate
}

const forbiddenSchemaKeywords = new Set(['minLength', 'minimum', 'maximum', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'oneOf', 'allOf', '$ref'])
function assertDeepSeekTransportSchemaCompatible(schema, location = '$') {
  assert.equal(schema && typeof schema === 'object' && !Array.isArray(schema), true, `${location} must be a schema object`)
  for (const key of Object.keys(schema)) assert.equal(forbiddenSchemaKeywords.has(key), false, `${location} contains ${key}`)
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${location} must reject additional properties`)
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)), `${location} must require every property`)
    for (const [key, child] of Object.entries(schema.properties)) assertDeepSeekTransportSchemaCompatible(child, `${location}.${key}`)
  }
  if (schema.items) assertDeepSeekTransportSchemaCompatible(schema.items, `${location}[]`)
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
    if (claim.text.includes('INVALID_EVIDENCE')) return { status: 'evidence_found', provider: 'yuandian-law', claimId: claim.claimId, evidence: [{ sourceType: 'law', title: '不完整证据' }], warnings: [] }
    if (claim.text.includes('VERSION_WARNING')) return { status: 'evidence_found', provider: 'yuandian-law', claimId: claim.claimId, evidence: [{ sourceType: 'law', authorityAxis: 'normative', title: '中华人民共和国示例法', supports: '支持核验命题' }], warnings: ['version_resolution_not_explicit'] }
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

await test('stage1-transport-schema-compatible', () => assertDeepSeekTransportSchemaCompatible(SCREENING_TRANSPORT_SCHEMA))
await test('stage2-transport-schema-compatible', () => assertDeepSeekTransportSchemaCompatible(FINALIZATION_TRANSPORT_SCHEMA))
await test('stage1-schema-excludes-original-text', () => assert.equal('originalText' in SCREENING_TRANSPORT_SCHEMA.properties.findings.items.properties, false))
await test('stage1-schema-excludes-extraction-reliability', () => assert.equal('extractionReliability' in SCREENING_TRANSPORT_SCHEMA.properties.findings.items.properties, false))
await test('stage2-schema-cannot-redecide-location', () => {
  const properties = FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties
  for (const key of ['pdfPage', 'blockId', 'originalText', 'extractionReliability']) assert.equal(key in properties, false)
})
await test('stage2-schema-excludes-stage1-structural-fields', () => {
  const properties = FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties
  for (const key of ['issueType', 'ruleType', 'severity', 'retrievalRequired']) assert.equal(key in properties, false)
})
await test('stage2-no-issue-type', () => assert.equal('issueType' in FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties, false))
await test('stage2-no-rule-type', () => assert.equal('ruleType' in FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties, false))
await test('stage2-no-severity', () => assert.equal('severity' in FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties, false))
await test('stage2-no-retrieval-required', () => assert.equal('retrievalRequired' in FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items.properties, false))
await test('stage2-structural-field-injection-rejected', () => {
  for (const [key, value] of Object.entries({ issueType: 'wording', ruleType: 'static', severity: 'minor', retrievalRequired: 'no' })) {
    assert.throws(() => normalizeFinalizationTransport({ candidates: [finalDraft({ [key]: value })] }), (error) => error.code === 'deepseek_output_invalid')
  }
})
await test('nested-retrieval-claim-all-required', () => {
  const claimSchema = SCREENING_TRANSPORT_SCHEMA.properties.findings.items.properties.retrievalClaims.items
  assert.deepEqual(new Set(claimSchema.required), new Set(Object.keys(claimSchema.properties)))
})
await test('forbidden-transport-schema-keywords-absent', () => {
  assertDeepSeekTransportSchemaCompatible(SCREENING_TRANSPORT_SCHEMA)
  assertDeepSeekTransportSchemaCompatible(FINALIZATION_TRANSPORT_SCHEMA)
})
await test('blank-block-id-rejected', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ blockId: '', jurisdictionScope: '', humanReviewNote: '' })] })
  assert.throws(() => assertScreeningShape(normalized), (error) => error.code === 'deepseek_output_invalid')
  const normalizedFinding = normalized.findings[0]
  assert.equal('blockId' in normalizedFinding, true)
  assert.equal(normalizedFinding.blockId, '')
})
await test('blank-screening-optional-sentinels-omitted', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ jurisdictionScope: '', humanReviewNote: '' })] }).findings[0]
  assert.equal('jurisdictionScope' in normalized, false)
  assert.equal('humanReviewNote' in normalized, false)
})
await test('screening-neutral-enums-retained', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding()] }).findings[0]
  assert.equal(normalized.temporalContext, 'unspecified')
  assert.equal(normalized.disputeStatus, 'none')
})
await test('blank-claim-fields-omitted-before-validation', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ ruleType: 'verify', retrievalRequired: 'must', retrievalClaims: [retrievalClaim()] })] }).findings[0].retrievalClaims[0]
  assert.deepEqual(normalized, { kind: 'article_text', text: 'FOUND' })
})
await test('blank-finalization-sentinels-omitted', () => {
  const normalized = normalizeFinalizationTransport({ candidates: [finalDraft()] }).candidates[0]
  assert.equal('jurisdictionScope' in normalized, false)
  assert.equal('humanReviewNote' in normalized, false)
  assert.equal('correctedText' in normalized, false)
  assert.equal(normalized.temporalContext, 'unspecified')
  assert.equal(normalized.disputeStatus, 'none')
})
await test('invalid-reference-date-rejected-after-normalization', () => {
  const claim = normalizeScreeningTransport({ findings: [finding({ retrievalClaims: [retrievalClaim({ referenceDate: '2026-02-30' })] })] }).findings[0].retrievalClaims[0]
  assert.throws(() => validateRetrievalClaim({ ...claim, claimId: 'claim_test', documentId: 'document', chapterId: 'chapter', pdfPage: 1 }), /referenceDate/u)
})
await test('zero-pdf-page-rejected-server-side', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ pdfPage: 0 })] })
  assert.throws(() => assertScreeningShape(normalized), (error) => error.code === 'deepseek_output_invalid')
})
await test('negative-pdf-page-rejected-server-side', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ pdfPage: -1 })] })
  assert.throws(() => assertScreeningShape(normalized), (error) => error.code === 'deepseek_output_invalid')
})
await test('findings-limit-enforced-server-side', () => {
  const findings = Array.from({ length: MAX_FINDINGS + 1 }, (_, index) => finding({ draftId: `draft-${index}` }))
  assert.throws(() => assertScreeningShape(normalizeScreeningTransport({ findings })), (error) => error.code === 'deepseek_output_invalid')
})
await test('claims-per-finding-limit-enforced-server-side', () => {
  const retrievalClaims = Array.from({ length: MAX_CLAIMS_PER_FINDING + 1 }, (_, index) => retrievalClaim({ text: `claim-${index}` }))
  assert.throws(() => assertScreeningShape(normalizeScreeningTransport({ findings: [finding({ retrievalClaims })] })), (error) => error.code === 'deepseek_output_invalid')
})
await test('total-retrieval-claims-limit-retained', () => assert.equal(MAX_RETRIEVAL_CLAIMS, 100))
await test('candidate-limit-enforced-server-side', () => {
  const candidates = Array.from({ length: MAX_CANDIDATES + 1 }, () => finalDraft())
  assert.throws(() => assertFinalShape(normalizeFinalizationTransport({ candidates }), [finding()]), (error) => error.code === 'deepseek_output_invalid')
})
await test('duplicate-evidence-claim-ids-rejected-server-side', () => {
  const normalized = normalizeFinalizationTransport({ candidates: [finalDraft({ evidenceClaimIds: ['claim_a', 'claim_a'] })] })
  assert.throws(() => assertFinalShape(normalized, [finding()]), (error) => error.code === 'deepseek_output_invalid')
})
await test('empty-semantic-text-rejected-after-normalization', () => {
  const normalized = normalizeScreeningTransport({ findings: [finding({ suggestionDraft: '   ' })] })
  assert.throws(() => assertScreeningShape(normalized), (error) => error.code === 'deepseek_output_invalid')
})
await test('model-original-text-property-rejected-by-stage1-transport', () => {
  assert.throws(() => normalizeScreeningTransport({ findings: [finding({ originalText: '模型伪造原文' })] }), (error) => error.code === 'deepseek_output_invalid')
})
await test('model-extraction-reliability-property-rejected-by-stage1-transport', () => {
  assert.throws(() => normalizeScreeningTransport({ findings: [finding({ extractionReliability: 'low' })] }), (error) => error.code === 'deepseek_output_invalid')
})
const hydrationBundle = {
  startPdfPage: 1,
  endPdfPage: 2,
  pages: [
    { pdfPage: 1, extractionReliability: 'high', blocks: [{ blockId: 'block-1', text: '这里有  错误表述，\n需要校对。' }, { blockId: 'block-neighbor', text: '相邻上下文。' }] },
    { pdfPage: 2, extractionReliability: 'medium', blocks: [{ blockId: 'block-2', text: '可疑提取文本。' }] },
  ],
}
await test('valid-location-hydrates-exact-server-block-text', () => assert.equal(hydrateFindingLocation(hydrationBundle, finding()).originalText, hydrationBundle.pages[0].blocks[0].text))
await test('ready-page-injects-high-reliability', () => assert.equal(hydrateFindingLocation(hydrationBundle, finding()).extractionReliability, 'high'))
await test('suspicious-page-injects-medium-reliability', () => assert.equal(hydrateFindingLocation(hydrationBundle, finding({ pdfPage: 2, blockId: 'block-2' })).extractionReliability, 'medium'))
await test('hydration-overwrites-any-source-text-value', () => assert.equal(hydrateFindingLocation(hydrationBundle, finding({ originalText: '模型值' })).originalText, hydrationBundle.pages[0].blocks[0].text))
await test('hydration-overwrites-any-reliability-value', () => assert.equal(hydrateFindingLocation(hydrationBundle, finding({ extractionReliability: 'low' })).extractionReliability, 'high'))
await test('invalid-page-fails-closed-with-safe-category', () => {
  assert.throws(() => locationGate(hydrationBundle, [finding({ pdfPage: 3 })]), (error) => error.code === 'deepseek_output_invalid' && error.failurePhase === 'location_gate' && error.locationFailureCategory === 'page_not_found')
})
await test('invalid-block-fails-closed-with-safe-category', () => {
  assert.throws(() => locationGate(hydrationBundle, [finding({ blockId: 'missing-block' })]), (error) => error.code === 'deepseek_output_invalid' && error.failurePhase === 'location_gate' && error.locationFailureCategory === 'block_not_found')
})
await test('block-id-is-not-fuzzy-matched', () => {
  assert.throws(() => locationGate(hydrationBundle, [finding({ blockId: 'block-1 ' })]), (error) => error.locationFailureCategory === 'block_not_found')
})
await test('stage1-prompt-requires-exact-primary-block-anchor', () => {
  const instructions = screeningInstructions('policy')
  for (const phrase of ['exactly one existing pdfPage + blockId', 'Copy pdfPage and blockId identifiers exactly', 'server, not the model, determines source text and extraction reliability', 'single primary block']) assert.equal(instructions.includes(phrase), true)
  assert.equal(instructions.includes('Use blockId,'), false)
})
await test('stage2-prompt-fixes-screening-and-retrieval-classification', () => {
  const instructions = finalizationInstructions('policy')
  assert.equal(instructions.includes('Do not reclassify issueType, ruleType, severity, or retrievalRequired'), true)
  assert.equal(instructions.includes('omit it from candidates; do not change ruleType'), true)
})
await test('static-high-forces-not-required', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ verificationStatus: 'verified' }))
  assert.equal(result.candidate.verificationStatus, 'not_required')
  assert.deepEqual(result.categories, ['static_verification_to_not_required'])
})
await test('static-low-forces-manual-check-and-downgrades-confirmed', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ extractionReliability: 'low', verificationStatus: 'verified' }))
  assert.equal(result.candidate.verificationStatus, 'manual_check_required')
  assert.equal(result.candidate.judgement, 'likely_error')
  assert.deepEqual(result.categories, ['static_low_extraction_to_manual_check_required', 'low_extraction_confirmed_to_likely_error'])
})
await test('verify-not-required-downgrades-to-unverified', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'not_required', judgement: 'likely_error' }))
  assert.equal(result.candidate.verificationStatus, 'unverified')
  assert.deepEqual(result.categories, ['verify_not_required_to_unverified'])
})
await test('verified-without-evidence-downgrades-status-and-judgement', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'verified' }))
  assert.equal(result.candidate.verificationStatus, 'insufficient_evidence')
  assert.equal(result.candidate.judgement, 'likely_error')
  assert.deepEqual(result.categories, ['verified_without_evidence_to_insufficient_evidence', 'verified_without_evidence_confirmed_to_likely_error'])
})
await test('verify-nonverified-confirmed-downgrades-judgement', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'unverified' }))
  assert.equal(result.candidate.judgement, 'likely_error')
  assert.deepEqual(result.categories, ['verify_nonverified_confirmed_to_likely_error'])
})
await test('academic-dispute-confirmed-downgrades-to-ambiguous', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ disputeStatus: 'academic_dispute' }))
  assert.equal(result.candidate.judgement, 'ambiguous')
  assert.deepEqual(result.categories, ['academic_dispute_confirmed_to_ambiguous'])
})
await test('version-uncertainty-downgrades-verified-and-confirmed', () => {
  const result = applyConservativeCandidatePolicy(policyCandidate({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'verified', evidence: [{ sourceType: 'law', authorityAxis: 'normative', title: '合成法', supports: '合成支持' }] }), { versionResolutionNotExplicit: true })
  assert.equal(result.candidate.verificationStatus, 'insufficient_evidence')
  assert.equal(result.candidate.judgement, 'likely_error')
  assert.deepEqual(result.categories, ['version_uncertain_verified_to_insufficient_evidence', 'version_uncertain_confirmed_to_likely_error'])
})
await test('server-policy-never-upgrades-verification', () => {
  for (const verificationStatus of ['unverified', 'insufficient_evidence', 'manual_check_required']) {
    const result = applyConservativeCandidatePolicy(policyCandidate({ ruleType: 'judgement', verificationStatus, judgement: 'likely_error' }))
    assert.notEqual(result.candidate.verificationStatus, 'verified')
  }
})
await test('normalization-categories-are-finite-and-content-free', () => {
  assert.equal(CANDIDATE_POLICY_NORMALIZATION_CATEGORIES.every((category) => /^[a-z_]+$/u.test(category)), true)
  assert.equal(JSON.stringify(CANDIDATE_POLICY_NORMALIZATION_CATEGORIES).includes('合成候选文本'), false)
})
await test('candidate-invariant-errors-remain-authoritative-after-normalization', () => {
  const before = policyCandidate({ ruleType: 'verify', retrievalRequired: 'must', verificationStatus: 'not_required' })
  assert.equal(candidateInvariantErrors(before).length > 0, true)
  const after = applyConservativeCandidatePolicy(before).candidate
  assert.deepEqual(candidateInvariantErrors(after), [])
})
await test('candidate-contract-stable-id-unchanged', () => {
  const candidate = { schemaVersion: '0.1', id: '', documentId: 'document', chapterId: 'chapter', pdfPage: 1, blockId: 'block-1', originalText: '错误表述', issueType: 'wording', ruleType: 'static', severity: 'minor', extractionReliability: 'high', verificationStatus: 'not_required', retrievalRequired: 'no', evidence: [], judgement: 'confirmed_error', suggestion: '正确表述', reason: '静态语言问题', confidence: 'high', temporalContext: 'unspecified', disputeStatus: 'none', humanResolution: 'pending' }
  candidate.id = stableCandidateId(candidate)
  assert.deepEqual(validateCandidateIssue(candidate), [])
})

const root = await mkdtemp(path.join(tmpdir(), 'ai-review-runtime-'))
const model = new MockModelClient()
const retrieval = new MockRetrievalAdapter()
const logs = []
const app = await createIngestionServer({ storageRoot: root, authRequired: false, modelClient: model, retrievalAdapter: retrieval, runtimeLogger: { error: (entry) => logs.push(entry) } })
const base = await listen(app)
try {
  const chapter = await fixture(app, 'happy-document', [
    { classification: 'native_ready', status: 'ready', text: '这里有  错误表述，\n需要校对。', blockId: 'block-1' },
    { classification: 'native_suspicious', status: 'suspicious', text: '可疑提取文本。', blockId: 'block-2' },
    { classification: 'ocr_not_needed', status: 'ready', text: '', blockId: 'block-3' },
  ])
  model.behaviors.set('happy-document', {
    findings: [finding(), finding({ draftId: 'draft-2', pdfPage: 2, blockId: 'block-2', issueType: 'terminology_inconsistency', severity: 'major' })],
    candidates: [finalDraft(), finalDraft({ draftId: 'draft-2' })],
  })
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
  await test('stage1-uses-transport-schema', () => assert.deepEqual(lowCall.request.schema, SCREENING_TRANSPORT_SCHEMA))
  await test('stage2-uses-transport-schema', () => assert.deepEqual(highCall.request.schema, FINALIZATION_TRANSPORT_SCHEMA))
  await test('stage2-output-schema-has-no-stage1-structural-fields', () => {
    const properties = highCall.request.schema.properties.candidates.items.properties
    for (const key of ['issueType', 'ruleType', 'severity', 'retrievalRequired']) assert.equal(key in properties, false)
  })
  await test('queue-concurrency-one-contract', () => assert.equal(AI_REVIEW_QUEUE_CONCURRENCY, 1))
  await test('candidate-id-server-generated', () => assert.match(happy.candidates[0].candidate.id, /^ltp_[a-f0-9]{16}$/))
  await test('human-resolution-pending', () => assert.equal(happy.candidates.every(({ candidate }) => candidate.humanResolution === 'pending'), true))
  await test('no-automatic-human-acceptance', () => assert.equal(happy.candidates.every(({ resolution }) => resolution.status === 'pending'), true))
  await test('candidate-validates', () => assert.equal(happy.candidates.every(({ candidate }) => validateCandidateIssue(candidate).length === 0), true))
  await test('server-owned-location', () => { assert.equal(happy.candidates[0].candidate.documentId, 'happy-document'); assert.equal(happy.candidates[0].candidate.chapterId, chapter.id); assert.equal(happy.candidates[0].candidate.blockId, 'block-1') })
  await test('candidate-original-text-is-exact-server-block', () => assert.equal(happy.candidates[0].candidate.originalText, '这里有  错误表述，\n需要校对。'))
  await test('candidate-high-reliability-is-server-owned', () => assert.equal(happy.candidates.find(({ candidate }) => candidate.blockId === 'block-1').candidate.extractionReliability, 'high'))
  await test('candidate-medium-reliability-is-server-owned', () => assert.equal(happy.candidates.find(({ candidate }) => candidate.blockId === 'block-2').candidate.extractionReliability, 'medium'))
  await test('candidate-structural-fields-come-from-stage1', () => {
    const candidate = happy.candidates.find((entry) => entry.candidate.blockId === 'block-2').candidate
    assert.equal(candidate.issueType, 'terminology_inconsistency')
    assert.equal(candidate.ruleType, 'static')
    assert.equal(candidate.severity, 'major')
    assert.equal(candidate.retrievalRequired, 'no')
  })
  await test('final-issue-type-comes-from-stage1', () => assert.equal(happy.candidates.find((entry) => entry.candidate.blockId === 'block-2').candidate.issueType, 'terminology_inconsistency'))
  await test('final-rule-type-comes-from-stage1', () => assert.equal(happy.candidates[0].candidate.ruleType, 'static'))
  await test('final-severity-comes-from-stage1', () => assert.equal(happy.candidates.find((entry) => entry.candidate.blockId === 'block-2').candidate.severity, 'major'))
  await test('final-retrieval-required-comes-from-stage1', () => assert.equal(happy.candidates[0].candidate.retrievalRequired, 'no'))
  await test('stable-id-uses-server-owned-original-text', () => assert.equal(happy.candidates[0].candidate.id, stableCandidateId(happy.candidates[0].candidate)))
  await test('stage2-receives-server-owned-original-text', () => assert.equal(highCall.input.findings[0].originalText, '这里有  错误表述，\n需要校对。'))
  await test('stage2-receives-server-owned-extraction-reliability', () => { assert.equal(highCall.input.findings[0].extractionReliability, 'high'); assert.equal(highCall.input.findings[1].extractionReliability, 'medium') })
  await test('partial-coverage-retained', () => assert.deepEqual(happy.aiRun.coverage, { totalPages: 3, readyPages: 1, suspiciousPages: 1, unavailablePages: 0, blankPages: 1, coveredTextPages: 2, complete: false }))
  await test('usage-metadata-stored', () => assert.equal(happy.aiRun.usage.total.total_tokens, usage(5).total_tokens + usage(9).total_tokens))
  await test('zero-policy-normalizations-stored', () => { assert.equal(happy.aiRun.candidatePolicyNormalizationCount, 0); assert.deepEqual(happy.aiRun.candidatePolicyNormalizationCategories, []) })
  await test('skill-hash-stored', () => assert.match(happy.aiRun.skillHash, /^[a-f0-9]{64}$/))
  await test('raw-reasoning-not-stored', () => assert.equal(JSON.stringify(happy).includes('private reasoning'), false))
  await test('prompt-not-stored', () => assert.equal(JSON.stringify(happy).includes('Runtime rules'), false))
  await test('raw-provider-response-not-stored', () => assert.equal('output' in happy.aiRun, false))
  await test('no-auto-chapter-completion', async () => assert.equal((await app.documentRepository.getChapter('happy-document', chapter.id)).status, 'in_progress'))

  const retrievalChapter = await fixture(app, 'retrieval-document')
  model.behaviors.set('retrieval-document', {
    findings: [
      finding({ draftId: 'found', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'FOUND', knownSourceTitle: '示例法', knownArticleNumber: '第一条' })] }),
      finding({ draftId: 'not-found', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'NOT_FOUND' })] }),
      finding({ draftId: 'insufficient', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'INSUFFICIENT' })] }),
      finding({ draftId: 'unavailable', ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'UNAVAILABLE' })] }),
    ],
    candidates: (input) => [{ ...finalDraft({ draftId: 'found', verificationStatus: 'verified', judgement: 'confirmed_error', evidenceClaimIds: [claimId('found')] }) }],
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
  await test('retrieval-candidate-structural-fields-come-from-stage1', () => {
    const candidate = retrievalWorkspace.candidates[0].candidate
    assert.equal(candidate.issueType, 'article_number')
    assert.equal(candidate.ruleType, 'verify')
    assert.equal(candidate.severity, 'minor')
    assert.equal(candidate.retrievalRequired, 'must')
  })
  await test('retrieval-counts-stored', () => { assert.equal(retrievalWorkspace.aiRun.retrievalClaimCount, 4); assert.equal(retrievalWorkspace.aiRun.evidenceFoundCount, 1) })
  await test('retrieval-concurrency-bounded-three', () => assert.equal(retrieval.maxActive <= 3, true))

  const normalizationChapter = await fixture(app, 'normalization-document')
  model.behaviors.set('normalization-document', { candidates: [finalDraft({ verificationStatus: 'verified' })] })
  await app.aiReviewService.startAiRun('normalization-document', normalizationChapter.id, 0); app.aiReviewRuntimeService.enqueue('normalization-document', normalizationChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const normalizationWorkspace = await app.aiReviewService.get('normalization-document', normalizationChapter.id)
  await test('static-high-runtime-forces-not-required', () => assert.equal(normalizationWorkspace.candidates[0].candidate.verificationStatus, 'not_required'))
  await test('normalization-count-stored', () => assert.equal(normalizationWorkspace.aiRun.candidatePolicyNormalizationCount, 1))
  await test('normalization-category-stored', () => assert.deepEqual(normalizationWorkspace.aiRun.candidatePolicyNormalizationCategories, ['static_verification_to_not_required']))
  await test('normalization-diagnostics-contain-no-candidate-text', () => assert.equal(JSON.stringify({ count: normalizationWorkspace.aiRun.candidatePolicyNormalizationCount, categories: normalizationWorkspace.aiRun.candidatePolicyNormalizationCategories }).includes('这里有错误表述'), false))
  await test('validate-candidate-runs-after-normalization', () => assert.deepEqual(validateCandidateIssue(normalizationWorkspace.candidates[0].candidate), []))

  const noEvidenceChapter = await fixture(app, 'verified-no-evidence-document')
  model.behaviors.set('verified-no-evidence-document', {
    findings: [finding({ ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'FOUND' })] })],
    candidates: [finalDraft({ verificationStatus: 'verified', judgement: 'confirmed_error', evidenceClaimIds: [] })],
  })
  await app.aiReviewService.startAiRun('verified-no-evidence-document', noEvidenceChapter.id, 0); app.aiReviewRuntimeService.enqueue('verified-no-evidence-document', noEvidenceChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const noEvidenceWorkspace = await app.aiReviewService.get('verified-no-evidence-document', noEvidenceChapter.id)
  await test('verified-without-selected-evidence-runtime-downgrades-status', () => assert.equal(noEvidenceWorkspace.candidates[0].candidate.verificationStatus, 'insufficient_evidence'))
  await test('verified-without-selected-evidence-runtime-downgrades-judgement', () => assert.equal(noEvidenceWorkspace.candidates[0].candidate.judgement, 'likely_error'))

  const evidenceNoUpgradeChapter = await fixture(app, 'evidence-no-upgrade-document')
  model.behaviors.set('evidence-no-upgrade-document', {
    findings: [finding({ ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'FOUND' })] })],
    candidates: [finalDraft({ verificationStatus: 'unverified', judgement: 'likely_error', evidenceClaimIds: [claimId('draft-1')] })],
  })
  await app.aiReviewService.startAiRun('evidence-no-upgrade-document', evidenceNoUpgradeChapter.id, 0); app.aiReviewRuntimeService.enqueue('evidence-no-upgrade-document', evidenceNoUpgradeChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const evidenceNoUpgradeWorkspace = await app.aiReviewService.get('evidence-no-upgrade-document', evidenceNoUpgradeChapter.id)
  await test('evidence-found-alone-does-not-upgrade-verification', () => assert.equal(evidenceNoUpgradeWorkspace.candidates[0].candidate.verificationStatus, 'unverified'))

  const versionChapter = await fixture(app, 'version-warning-document')
  model.behaviors.set('version-warning-document', {
    findings: [finding({ ruleType: 'verify', issueType: 'law_status', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'VERSION_WARNING' })] })],
    candidates: [finalDraft({ verificationStatus: 'verified', judgement: 'confirmed_error', evidenceClaimIds: [claimId('draft-1')] })],
  })
  await app.aiReviewService.startAiRun('version-warning-document', versionChapter.id, 0); app.aiReviewRuntimeService.enqueue('version-warning-document', versionChapter.id); await app.aiReviewRuntimeService.waitForIdle()
  const versionWorkspace = await app.aiReviewService.get('version-warning-document', versionChapter.id)
  await test('version-warning-runtime-downgrades-verified', () => assert.equal(versionWorkspace.candidates[0].candidate.verificationStatus, 'insufficient_evidence'))
  await test('version-warning-runtime-downgrades-confirmed', () => assert.equal(versionWorkspace.candidates[0].candidate.judgement, 'likely_error'))
  await test('version-warning-normalizations-audited', () => assert.deepEqual(versionWorkspace.aiRun.candidatePolicyNormalizationCategories, ['version_uncertain_verified_to_insufficient_evidence', 'version_uncertain_confirmed_to_likely_error']))

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
  await test('model-cannot-output-original-text', () => failureCase('model-source-document', { findings: [finding({ originalText: '不存在的原文' })] }, 'deepseek_output_invalid'))
  await test('model-cannot-output-extraction-reliability', () => failureCase('model-reliability-document', { findings: [finding({ extractionReliability: 'low' })] }, 'deepseek_output_invalid'))
  await test('block-id-mismatch-rejected-with-safe-diagnostics', async () => {
    const { workspace } = await failureCase('block-mismatch-document', { findings: [finding({ blockId: 'invented-block' })] }, 'deepseek_output_invalid')
    assert.equal(workspace.aiRun.failurePhase, 'location_gate')
    assert.equal(workspace.aiRun.locationFailureCategory, 'block_not_found')
  })
  await test('page-outside-chapter-rejected-with-safe-diagnostics', async () => {
    const { workspace } = await failureCase('page-outside-document', { findings: [finding({ pdfPage: 2 })] }, 'deepseek_output_invalid')
    assert.equal(workspace.aiRun.failurePhase, 'location_gate')
    assert.equal(workspace.aiRun.locationFailureCategory, 'page_not_found')
  })
  await test('runtime-does-not-fuzzy-match-block-id', () => failureCase('fuzzy-block-document', { findings: [finding({ blockId: 'block-1 ' })] }, 'deepseek_output_invalid'))
  await test('controlled-enum-enforced', () => failureCase('enum-document', { findings: [finding({ severity: 'catastrophic' })] }, 'deepseek_output_invalid'))
  await test('stage1-static-retrieval-mismatch-fails-before-stage2', () => failureCase('static-routing-mismatch-document', { findings: [finding({ retrievalRequired: 'should' })] }, 'deepseek_output_invalid'))
  await test('stage1-verify-retrieval-mismatch-fails-before-stage2', () => failureCase('verify-routing-mismatch-document', { findings: [finding({ ruleType: 'verify', retrievalRequired: 'should' })] }, 'deepseek_output_invalid'))
  await test('empty-required-semantic-text-rejected-after-normalization', () => failureCase('empty-text-document', { findings: [finding({ reasonDraft: '   ' })] }, 'deepseek_output_invalid'))
  await test('more-than-100-findings-rejected-server-side', () => failureCase('too-many-findings-document', { findings: Array.from({ length: MAX_FINDINGS + 1 }, (_, index) => finding({ draftId: `finding-${index}` })) }, 'deepseek_output_invalid'))
  await test('more-than-3-claims-per-finding-rejected-server-side', () => failureCase('too-many-claims-document', { findings: [finding({ retrievalClaims: Array.from({ length: MAX_CLAIMS_PER_FINDING + 1 }, (_, index) => retrievalClaim({ text: `claim-${index}` })) })] }, 'deepseek_output_invalid'))
  await test('total-retrieval-claim-limit-rejected-server-side', () => failureCase('too-many-total-claims-document', { findings: Array.from({ length: 51 }, (_, index) => finding({ draftId: `claim-finding-${index}`, retrievalClaims: [retrievalClaim({ text: `claim-${index}-a` }), retrievalClaim({ text: `claim-${index}-b` })] })) }, 'deepseek_output_invalid'))
  await test('unknown-evidence-claim-rejected', () => failureCase('unknown-evidence-document', { candidates: [finalDraft({ evidenceClaimIds: ['invented-claim'] })] }, 'deepseek_output_invalid'))
  await test('duplicate-evidence-claim-ids-rejected', () => failureCase('duplicate-evidence-document', { candidates: [finalDraft({ evidenceClaimIds: ['duplicate', 'duplicate'] })] }, 'deepseek_output_invalid'))
  await test('more-than-100-candidates-rejected-server-side', () => failureCase('too-many-candidates-document', { candidates: Array.from({ length: MAX_CANDIDATES + 1 }, () => finalDraft()) }, 'deepseek_output_invalid'))
  await test('model-candidate-id-field-rejected', () => failureCase('model-id-document', { candidates: [finalDraft({ id: 'model-controlled' })] }, 'deepseek_output_invalid'))
  await test('model-full-evidence-field-rejected', () => failureCase('model-evidence-document', { candidates: [finalDraft({ evidence: [{ title: 'invented' }] })] }, 'deepseek_output_invalid'))
  await test('stage2-cannot-alter-retrieval-semantics', () => failureCase('stage2-routing-document', { candidates: [finalDraft({ retrievalRequired: 'must' })] }, 'deepseek_output_invalid'))
  await test('schema-invalid-candidate-fails-whole-run-with-safe-category', async () => {
    const { workspace } = await failureCase('invalid-candidate-document', {
      findings: [finding({ ruleType: 'verify', issueType: 'article_number', retrievalRequired: 'must', retrievalClaims: [retrievalClaim({ text: 'INVALID_EVIDENCE' })] })],
      candidates: [finalDraft({ verificationStatus: 'verified', evidenceClaimIds: [claimId('draft-1')] })],
    }, 'candidate_validation_failed')
    assert.equal(workspace.aiRun.failurePhase, 'candidate_validation')
    assert.equal(workspace.aiRun.candidateFailureCategory, 'schema_invalid')
  })
  await test('deepseek-failure-becomes-ai-failed', () => failureCase('provider-failure-document', { screeningError: new DeepSeekProviderError('deepseek_rate_limited', { status: 429 }) }, 'deepseek_rate_limited'))
  await test('sanitized-upstream-diagnostics-persist-without-provider-message', async () => {
    const providerError = new DeepSeekProviderError('deepseek_bad_response', { status: 400, upstreamErrorCategory: 'invalid_json_schema', upstreamErrorCode: 'invalid_schema' })
    providerError.providerMessage = 'SENSITIVE ARBITRARY UPSTREAM MESSAGE'
    providerError.request = { prompt: 'SENSITIVE PROMPT', schema: 'SENSITIVE SCHEMA' }
    const { workspace } = await failureCase('sanitized-diagnostic-document', { screeningError: providerError }, 'deepseek_bad_response')
    assert.equal(workspace.aiRun.upstreamErrorCategory, 'invalid_json_schema')
    assert.equal(workspace.aiRun.upstreamErrorCode, 'invalid_schema')
    assert.equal(JSON.stringify(workspace).includes('SENSITIVE'), false)
    assert.equal(JSON.stringify(logs).includes('SENSITIVE'), false)
  })
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
  await test('conflicting-duplicate-fails-with-safe-category', async () => {
    const { workspace } = await failureCase('duplicate-conflict-document', { candidates: [finalDraft(), finalDraft({ suggestion: '另一建议' })] }, 'candidate_validation_failed')
    assert.equal(workspace.aiRun.failurePhase, 'candidate_validation')
    assert.equal(workspace.aiRun.candidateFailureCategory, 'duplicate_candidate_conflict')
  })

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
  await test('location-log-contains-only-safe-diagnostics', () => {
    const locationLogs = logs.filter((entry) => entry.failurePhase === 'location_gate')
    assert.equal(locationLogs.length >= 3, true)
    assert.equal(locationLogs.every((entry) => ['page_not_found', 'block_not_found'].includes(entry.locationFailureCategory)), true)
    assert.equal(JSON.stringify(locationLogs).includes('这里有错误表述'), false)
    assert.equal(JSON.stringify(locationLogs).includes('invented-block'), false)
  })
  await test('candidate-validation-logs-contain-only-safe-diagnostics', () => {
    const candidateLogs = logs.filter((entry) => entry.failurePhase === 'candidate_validation')
    assert.equal(candidateLogs.length >= 2, true)
    assert.equal(candidateLogs.every((entry) => ['schema_invalid', 'duplicate_candidate_conflict'].includes(entry.candidateFailureCategory)), true)
    const serialized = JSON.stringify(candidateLogs)
    assert.equal(serialized.includes('这里有错误表述'), false)
    assert.equal(serialized.includes('另一建议'), false)
    assert.equal(serialized.includes('不完整证据'), false)
  })
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

assert.equal(testCount >= 65, true)
console.log(`ai-review-runtime-test-count=${testCount}`)
console.log('real-deepseek-requests=0')
