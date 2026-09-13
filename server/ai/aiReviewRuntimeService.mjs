import { createHash } from 'node:crypto'
import { candidateIssueTypes, stableCandidateId, validateCandidateIssue } from '../candidates/candidateContract.mjs'
import { CLAIM_KINDS, validateRetrievalClaim } from '../retrieval/types.mjs'
import { DeepSeekProviderError } from './deepseekResponsesClient.mjs'
import { loadLegalSkillPrompt } from './legalSkillPrompt.mjs'

export const AI_REVIEW_QUEUE_CONCURRENCY = 1
export const RETRIEVAL_CONCURRENCY = 3
export const STAGE1_MAX_OUTPUT_TOKENS = 32_768
export const STAGE2_MAX_OUTPUT_TOKENS = 49_152
export const MAX_FINDINGS = 100
export const MAX_CLAIMS_PER_FINDING = 3
export const MAX_RETRIEVAL_CLAIMS = 100
export const MAX_CANDIDATES = 100

const ISSUE_TYPES = candidateIssueTypes()
const RULE_TYPES = ['static', 'verify', 'judgement']
const SEVERITIES = ['critical', 'major', 'minor', 'clarification']
const EXTRACTION_RELIABILITIES = ['high', 'medium', 'low']
const RETRIEVAL_REQUIREMENTS = ['must', 'should', 'no']
const TEMPORAL_CONTEXTS = ['current', 'historical', 'mixed', 'unspecified']
const DISPUTE_STATUSES = ['none', 'academic_dispute', 'judicial_divergence', 'unclear']
const VERIFICATION_STATUSES = ['not_required', 'unverified', 'verified', 'insufficient_evidence', 'manual_check_required']
const JUDGEMENTS = ['confirmed_error', 'likely_error', 'ambiguous', 'correct_but_misleading', 'correct_but_needs_qualification']
const CONFIDENCES = ['high', 'medium', 'low']

const retrievalClaimSchema = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'text'],
  properties: {
    kind: { type: 'string', enum: CLAIM_KINDS }, text: { type: 'string', minLength: 1 },
    knownSourceTitle: { type: 'string', minLength: 1 }, knownArticleNumber: { type: 'string', minLength: 1 },
    jurisdiction: { type: 'string', minLength: 1 }, referenceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
}

export const SCREENING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', maxItems: MAX_FINDINGS, items: {
    type: 'object', additionalProperties: false,
    required: ['draftId', 'pdfPage', 'originalText', 'issueType', 'ruleType', 'severity', 'extractionReliability', 'retrievalRequired', 'suggestionDraft', 'reasonDraft', 'retrievalClaims'],
    properties: {
      draftId: { type: 'string', minLength: 1 }, pdfPage: { type: 'integer', minimum: 1 }, blockId: { type: 'string', minLength: 1 },
      originalText: { type: 'string', minLength: 1 }, issueType: { type: 'string', enum: ISSUE_TYPES }, ruleType: { type: 'string', enum: RULE_TYPES },
      severity: { type: 'string', enum: SEVERITIES }, extractionReliability: { type: 'string', enum: EXTRACTION_RELIABILITIES },
      retrievalRequired: { type: 'string', enum: RETRIEVAL_REQUIREMENTS }, temporalContext: { type: 'string', enum: TEMPORAL_CONTEXTS },
      disputeStatus: { type: 'string', enum: DISPUTE_STATUSES }, jurisdictionScope: { type: 'string', minLength: 1 },
      suggestionDraft: { type: 'string', minLength: 1 }, reasonDraft: { type: 'string', minLength: 1 },
      retrievalClaims: { type: 'array', maxItems: MAX_CLAIMS_PER_FINDING, items: retrievalClaimSchema },
      humanReviewNote: { type: 'string', minLength: 1 },
    },
  } } },
}

export const FINALIZATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: { candidates: { type: 'array', maxItems: MAX_CANDIDATES, items: {
    type: 'object', additionalProperties: false,
    required: ['draftId', 'issueType', 'ruleType', 'severity', 'verificationStatus', 'retrievalRequired', 'judgement', 'suggestion', 'reason', 'confidence', 'evidenceClaimIds'],
    properties: {
      draftId: { type: 'string', minLength: 1 }, issueType: { type: 'string', enum: ISSUE_TYPES }, ruleType: { type: 'string', enum: RULE_TYPES },
      severity: { type: 'string', enum: SEVERITIES }, verificationStatus: { type: 'string', enum: VERIFICATION_STATUSES },
      retrievalRequired: { type: 'string', enum: RETRIEVAL_REQUIREMENTS }, judgement: { type: 'string', enum: JUDGEMENTS },
      suggestion: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 }, confidence: { type: 'string', enum: CONFIDENCES },
      temporalContext: { type: 'string', enum: TEMPORAL_CONTEXTS }, disputeStatus: { type: 'string', enum: DISPUTE_STATUSES },
      jurisdictionScope: { type: 'string', minLength: 1 }, humanReviewNote: { type: 'string', minLength: 1 }, correctedText: { type: 'string', minLength: 1 },
      evidenceClaimIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  } } },
}

class RuntimeFailure extends Error {
  constructor(code) { super(code); this.code = code }
}

function enumValue(value, values) { return typeof value === 'string' && values.includes(value) }
function textValue(value) { return typeof value === 'string' && value.trim().length > 0 }
function normalizedText(value) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
function hasOnlyKeys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)) }
function claimIdFor(draftId, index) {
  return `claim_${createHash('sha256').update(`${draftId}\n${index}`).digest('hex').slice(0, 16)}`
}
function optional(target, source, key) { if (source[key] !== undefined) target[key] = source[key] }

function assertScreeningShape(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    throw new RuntimeFailure('deepseek_output_invalid')
  }
  const draftIds = new Set()
  const findingKeys = ['draftId', 'pdfPage', 'blockId', 'originalText', 'issueType', 'ruleType', 'severity', 'extractionReliability', 'retrievalRequired', 'temporalContext', 'disputeStatus', 'jurisdictionScope', 'suggestionDraft', 'reasonDraft', 'retrievalClaims', 'humanReviewNote']
  const claimKeys = ['kind', 'text', 'knownSourceTitle', 'knownArticleNumber', 'jurisdiction', 'referenceDate']
  let totalClaims = 0
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || !hasOnlyKeys(finding, findingKeys) || !textValue(finding.draftId) || draftIds.has(finding.draftId) || !Number.isSafeInteger(finding.pdfPage) || finding.pdfPage < 1 ||
      !textValue(finding.originalText) || !enumValue(finding.issueType, ISSUE_TYPES) || !enumValue(finding.ruleType, RULE_TYPES) ||
      !enumValue(finding.severity, SEVERITIES) || !enumValue(finding.extractionReliability, EXTRACTION_RELIABILITIES) ||
      !enumValue(finding.retrievalRequired, RETRIEVAL_REQUIREMENTS) || !textValue(finding.suggestionDraft) || !textValue(finding.reasonDraft) ||
      !Array.isArray(finding.retrievalClaims) || finding.retrievalClaims.length > MAX_CLAIMS_PER_FINDING) {
      throw new RuntimeFailure('deepseek_output_invalid')
    }
    if (finding.blockId !== undefined && !textValue(finding.blockId)) throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.temporalContext !== undefined && !enumValue(finding.temporalContext, TEMPORAL_CONTEXTS)) throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.disputeStatus !== undefined && !enumValue(finding.disputeStatus, DISPUTE_STATUSES)) throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.retrievalRequired === 'must' && finding.retrievalClaims.length === 0) throw new RuntimeFailure('deepseek_output_invalid')
    for (const claim of finding.retrievalClaims) {
      if (!claim || typeof claim !== 'object' || !hasOnlyKeys(claim, claimKeys) || !enumValue(claim.kind, CLAIM_KINDS) || !textValue(claim.text)) throw new RuntimeFailure('deepseek_output_invalid')
    }
    totalClaims += finding.retrievalClaims.length
    draftIds.add(finding.draftId)
  }
  if (totalClaims > MAX_RETRIEVAL_CLAIMS) throw new RuntimeFailure('deepseek_output_invalid')
  return value.findings
}

function locationGate(bundle, findings) {
  const pages = new Map(bundle.pages.map((page) => [page.pdfPage, page]))
  for (const finding of findings) {
    const page = pages.get(finding.pdfPage)
    if (!page || finding.pdfPage < bundle.startPdfPage || finding.pdfPage > bundle.endPdfPage) throw new RuntimeFailure('deepseek_output_invalid')
    const blocks = finding.blockId === undefined ? page.blocks : page.blocks.filter((block) => block.blockId === finding.blockId)
    if (!blocks.length || !blocks.some((block) => normalizedText(block.text).includes(normalizedText(finding.originalText)))) {
      throw new RuntimeFailure('deepseek_output_invalid')
    }
    if (finding.extractionReliability !== page.extractionReliability) throw new RuntimeFailure('deepseek_output_invalid')
  }
}

function serverClaims(documentId, chapterId, findings) {
  const claims = []
  const seen = new Set()
  for (const finding of findings) {
    finding.retrievalClaims = finding.retrievalClaims.map((input, index) => {
      const claim = validateRetrievalClaim({
        ...input,
        claimId: claimIdFor(finding.draftId, index),
        documentId,
        chapterId,
        pdfPage: finding.pdfPage,
        ...(finding.temporalContext ? { temporalContext: finding.temporalContext } : {}),
      })
      if (seen.has(claim.claimId)) throw new RuntimeFailure('deepseek_output_invalid')
      seen.add(claim.claimId)
      claims.push(claim)
      return claim
    })
  }
  return claims
}

async function mapConcurrent(values, concurrency, operation) {
  const results = new Array(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await operation(values[index], index)
    }
  }))
  return results
}

function assertFinalShape(value, findings) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) {
    throw new RuntimeFailure('deepseek_output_invalid')
  }
  const knownDrafts = new Set(findings.map((finding) => finding.draftId))
  const candidateKeys = ['draftId', 'issueType', 'ruleType', 'severity', 'verificationStatus', 'retrievalRequired', 'judgement', 'suggestion', 'reason', 'confidence', 'temporalContext', 'disputeStatus', 'jurisdictionScope', 'humanReviewNote', 'correctedText', 'evidenceClaimIds']
  for (const candidate of value.candidates) {
    if (!candidate || typeof candidate !== 'object' || !hasOnlyKeys(candidate, candidateKeys) || !textValue(candidate.draftId) || !knownDrafts.has(candidate.draftId) || !enumValue(candidate.issueType, ISSUE_TYPES) ||
      !enumValue(candidate.ruleType, RULE_TYPES) || !enumValue(candidate.severity, SEVERITIES) ||
      !enumValue(candidate.verificationStatus, VERIFICATION_STATUSES) || !enumValue(candidate.retrievalRequired, RETRIEVAL_REQUIREMENTS) ||
      !enumValue(candidate.judgement, JUDGEMENTS) || !textValue(candidate.suggestion) || !textValue(candidate.reason) ||
      !enumValue(candidate.confidence, CONFIDENCES) || !Array.isArray(candidate.evidenceClaimIds) || new Set(candidate.evidenceClaimIds).size !== candidate.evidenceClaimIds.length) {
      throw new RuntimeFailure('deepseek_output_invalid')
    }
  }
  return value.candidates
}

function constructCandidates(documentId, chapterId, findings, finalDrafts, retrievalResults) {
  const findingById = new Map(findings.map((finding) => [finding.draftId, finding]))
  const resultById = new Map(retrievalResults.map((result) => [result.claimId, result]))
  const candidates = []
  for (const draft of finalDrafts) {
    const finding = findingById.get(draft.draftId)
    const allowedClaimIds = new Set(finding.retrievalClaims.map((claim) => claim.claimId))
    const evidence = []
    for (const claimId of draft.evidenceClaimIds) {
      if (!allowedClaimIds.has(claimId)) throw new RuntimeFailure('deepseek_output_invalid')
      const result = resultById.get(claimId)
      if (!result || result.status !== 'evidence_found' || !Array.isArray(result.evidence) || result.evidence.length === 0) {
        throw new RuntimeFailure('deepseek_output_invalid')
      }
      if (result.warnings?.includes('version_resolution_not_explicit') && draft.verificationStatus === 'verified') {
        throw new RuntimeFailure('candidate_validation_failed')
      }
      evidence.push(...structuredClone(result.evidence))
    }
    const candidate = {
      schemaVersion: '0.1', documentId, chapterId, pdfPage: finding.pdfPage,
      ...(finding.blockId ? { blockId: finding.blockId } : {}), originalText: finding.originalText,
      issueType: draft.issueType, ruleType: draft.ruleType, severity: draft.severity,
      extractionReliability: finding.extractionReliability, verificationStatus: draft.verificationStatus,
      retrievalRequired: draft.retrievalRequired, evidence, judgement: draft.judgement,
      suggestion: draft.suggestion, reason: draft.reason, confidence: draft.confidence,
      humanResolution: 'pending',
    }
    for (const key of ['temporalContext', 'disputeStatus', 'jurisdictionScope', 'humanReviewNote', 'correctedText']) optional(candidate, draft, key)
    candidate.id = stableCandidateId(candidate)
    if (validateCandidateIssue(candidate).length) throw new RuntimeFailure('candidate_validation_failed')
    candidates.push(candidate)
  }
  const unique = new Map()
  for (const candidate of candidates) {
    const previous = unique.get(candidate.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) throw new RuntimeFailure('candidate_validation_failed')
    unique.set(candidate.id, candidate)
  }
  return [...unique.values()]
}

function addUsage(left = {}, right = {}) {
  return Object.fromEntries(['input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens', 'total_tokens'].map((key) => [key, (left[key] ?? 0) + (right[key] ?? 0)]))
}

function safeFailureCode(error) {
  if (error instanceof RuntimeFailure || error instanceof DeepSeekProviderError) return error.code
  return 'deepseek_provider_error'
}

export class AiReviewRuntimeService {
  constructor({ aiReviewService, aiReviewRepository, bundleBuilder, modelClient, retrievalAdapter, maxChapterChars = 500_000, skillLoader = loadLegalSkillPrompt, logger = console }) {
    Object.assign(this, { aiReviewService, aiReviewRepository, bundleBuilder, modelClient, retrievalAdapter, maxChapterChars, skillLoader, logger })
    this.queue = []
    this.keys = new Set()
    this.running = false
    this.idleWaiters = []
  }

  status() { return this.modelClient.getStatus() }

  async init() {
    const interrupted = await this.aiReviewRepository.listRunningWorkspaces()
    for (const workspace of interrupted) {
      await this.aiReviewService.failAiRun(workspace.documentId, workspace.chapterId, 'runtime_interrupted', workspace.revision)
    }
  }

  enqueue(documentId, chapterId) {
    const key = `${documentId}:${chapterId}`
    if (this.keys.has(key)) return false
    this.keys.add(key)
    this.queue.push({ key, documentId, chapterId })
    queueMicrotask(() => { void this.#drain() })
    return true
  }

  async waitForIdle() {
    if (!this.running && this.queue.length === 0) return
    await new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  async #drain() {
    if (this.running) return
    this.running = true
    while (this.queue.length) {
      const job = this.queue.shift()
      try { await this.run(job.documentId, job.chapterId) } finally { this.keys.delete(job.key) }
    }
    this.running = false
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  async run(documentId, chapterId) {
    let coverage
    let skill
    let screeningUsage
    let finalizationUsage
    let findingCount = 0
    let retrievalClaimCount = 0
    let evidenceFoundCount = 0
    try {
      const running = await this.aiReviewService.get(documentId, chapterId)
      if (running.stage !== 'ai_running') return
      skill = await this.skillLoader()
      const bundle = await this.bundleBuilder.build(documentId, chapterId)
      coverage = bundle.coverage
      if (coverage.coveredTextPages === 0) throw new RuntimeFailure('chapter_text_unavailable')
      if (bundle.characterCount > this.maxChapterChars) throw new RuntimeFailure('chapter_text_too_large')

      const screening = await this.modelClient.requestStructured({
        instructions: `${skill.policy}\n\nRuntime rules: screen conservatively; candidate drafts are not final errata; human review is authoritative; do not claim retrieval was performed; protect historical and disputed statements.`,
        input: JSON.stringify({ chapter: bundle }), schema: SCREENING_SCHEMA, schemaName: 'legal_textbook_screening', reasoningEffort: 'low', maxOutputTokens: STAGE1_MAX_OUTPUT_TOKENS,
      })
      screeningUsage = screening.usage
      const findings = assertScreeningShape(screening.data)
      findingCount = findings.length
      locationGate(bundle, findings)
      const claims = serverClaims(documentId, chapterId, findings)
      retrievalClaimCount = claims.length
      const retrievalResults = await mapConcurrent(claims, RETRIEVAL_CONCURRENCY, (claim) => this.retrievalAdapter.retrieve(claim))
      evidenceFoundCount = retrievalResults.filter((result) => result.status === 'evidence_found').length

      const finalization = await this.modelClient.requestStructured({
        instructions: `${skill.policy}\n\nRuntime rules: emit only supported candidates; only supplied normalized evidence may support verification; refer to evidence by evidenceClaimIds only; omit uncertain findings; human review remains authoritative.`,
        input: JSON.stringify({ chapter: bundle, findings, retrievalResults }), schema: FINALIZATION_SCHEMA, schemaName: 'legal_textbook_finalization', reasoningEffort: 'high', maxOutputTokens: STAGE2_MAX_OUTPUT_TOKENS,
      })
      finalizationUsage = finalization.usage
      const finalDrafts = assertFinalShape(finalization.data, findings)
      const candidates = constructCandidates(documentId, chapterId, findings, finalDrafts, retrievalResults)
      const current = await this.aiReviewService.get(documentId, chapterId)
      await this.aiReviewService.completeAiRun(documentId, chapterId, candidates, current.revision, {
        provider: 'deepseek', model: this.status().model, skillVersion: skill.skillVersion, skillHash: skill.skillHash,
        coverage, usage: { screening: screeningUsage, finalization: finalizationUsage, total: addUsage(screeningUsage, finalizationUsage) },
        findingCount, retrievalClaimCount, evidenceFoundCount, candidateCount: candidates.length,
      })
    } catch (error) {
      const code = safeFailureCode(error)
      const status = this.status()
      this.logger.error?.({ provider: status.provider, model: status.model, httpStatus: error?.status, errorCode: code, durationMs: error?.durationMs, usage: error?.usage })
      try {
        const current = await this.aiReviewService.get(documentId, chapterId)
        if (current.stage === 'ai_running') {
          await this.aiReviewService.failAiRun(documentId, chapterId, code, current.revision, {
            provider: 'deepseek', model: status.model,
            ...(skill ? { skillVersion: skill.skillVersion, skillHash: skill.skillHash } : {}),
            ...(coverage ? { coverage } : {}),
            ...(screeningUsage || finalizationUsage ? { usage: { screening: screeningUsage, finalization: finalizationUsage, total: addUsage(screeningUsage, finalizationUsage) } } : {}),
            findingCount, retrievalClaimCount, evidenceFoundCount,
          })
        }
      } catch (transitionError) {
        this.logger.error?.({ provider: status.provider, model: status.model, errorCode: 'runtime_failure_transition_failed' })
      }
    }
  }

  async close() {
    await this.waitForIdle()
    await this.retrievalAdapter.close?.()
  }
}
