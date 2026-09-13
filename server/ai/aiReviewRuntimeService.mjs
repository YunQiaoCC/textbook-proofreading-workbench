import { createHash } from 'node:crypto'
import { stableCandidateId, validateCandidateIssue } from '../candidates/candidateContract.mjs'
import { CLAIM_KINDS, validateRetrievalClaim } from '../retrieval/types.mjs'
import { DeepSeekProviderError } from './deepseekResponsesClient.mjs'
import { loadLegalSkillPrompt } from './legalSkillPrompt.mjs'
import {
  CONFIDENCES,
  DISPUTE_STATUSES,
  EXTRACTION_RELIABILITIES,
  FINALIZATION_TRANSPORT_SCHEMA,
  ISSUE_TYPES,
  JUDGEMENTS,
  RETRIEVAL_REQUIREMENTS,
  RULE_TYPES,
  SCREENING_TRANSPORT_SCHEMA,
  SEVERITIES,
  TEMPORAL_CONTEXTS,
  VERIFICATION_STATUSES,
} from './deepseekTransportSchemas.mjs'

export const AI_REVIEW_QUEUE_CONCURRENCY = 1
export const RETRIEVAL_CONCURRENCY = 3
export const STAGE1_MAX_OUTPUT_TOKENS = 32_768
export const STAGE2_MAX_OUTPUT_TOKENS = 49_152
export const MAX_FINDINGS = 100
export const MAX_CLAIMS_PER_FINDING = 3
export const MAX_RETRIEVAL_CLAIMS = 100
export const MAX_CANDIDATES = 100

export function screeningInstructions(policy) {
  return `${policy}\n\nRuntime rules: screen conservatively; candidate drafts are not final errata; human review is authoritative; do not claim retrieval was performed; protect historical and disputed statements. Every transport field is required. Use blockId, jurisdictionScope, humanReviewNote, and unavailable retrieval claim fields as empty strings; use temporalContext=unspecified and disputeStatus=none or unclear when no stronger value is supported.`
}

export function finalizationInstructions(policy) {
  return `${policy}\n\nRuntime rules: emit only supported candidates; only supplied normalized evidence may support verification; refer to evidence by evidenceClaimIds only; omit uncertain findings; human review remains authoritative. Every transport field is required. Use jurisdictionScope, humanReviewNote, and correctedText as empty strings; use temporalContext=unspecified, disputeStatus=none, and evidenceClaimIds=[] when appropriate.`
}

class RuntimeFailure extends Error {
  constructor(code) { super(code); this.code = code }
}

function enumValue(value, values) { return typeof value === 'string' && values.includes(value) }
function textValue(value) { return typeof value === 'string' && value.trim().length > 0 }
function normalizedText(value) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim() }
function hasOnlyKeys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)) }
function assertTransportObject(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeFailure('deepseek_output_invalid')
  const properties = Object.keys(schema.properties)
  if (!hasOnlyKeys(value, properties) || properties.some((key) => !Object.hasOwn(value, key))) {
    throw new RuntimeFailure('deepseek_output_invalid')
  }
}
function normalizedOptionalString(target, source, key) {
  const value = source[key]
  if (typeof value !== 'string') {
    target[key] = value
    return
  }
  const trimmed = value.trim()
  if (trimmed) target[key] = trimmed
}
function claimIdFor(draftId, index) {
  return `claim_${createHash('sha256').update(`${draftId}\n${index}`).digest('hex').slice(0, 16)}`
}
function optional(target, source, key) { if (source[key] !== undefined) target[key] = source[key] }

export function normalizeScreeningTransport(value) {
  assertTransportObject(value, SCREENING_TRANSPORT_SCHEMA)
  if (!Array.isArray(value.findings)) throw new RuntimeFailure('deepseek_output_invalid')
  const findingSchema = SCREENING_TRANSPORT_SCHEMA.properties.findings.items
  const claimSchema = findingSchema.properties.retrievalClaims.items
  return {
    findings: value.findings.map((finding) => {
      assertTransportObject(finding, findingSchema)
      if (!Array.isArray(finding.retrievalClaims)) throw new RuntimeFailure('deepseek_output_invalid')
      const normalized = {
        draftId: finding.draftId,
        pdfPage: finding.pdfPage,
        originalText: finding.originalText,
        issueType: finding.issueType,
        ruleType: finding.ruleType,
        severity: finding.severity,
        extractionReliability: finding.extractionReliability,
        retrievalRequired: finding.retrievalRequired,
        temporalContext: finding.temporalContext,
        disputeStatus: finding.disputeStatus,
        suggestionDraft: finding.suggestionDraft,
        reasonDraft: finding.reasonDraft,
        retrievalClaims: finding.retrievalClaims.map((claim) => {
          assertTransportObject(claim, claimSchema)
          const normalizedClaim = {
            kind: claim.kind,
            text: typeof claim.text === 'string' ? claim.text.trim() : claim.text,
          }
          for (const key of ['knownSourceTitle', 'knownArticleNumber', 'jurisdiction', 'referenceDate']) {
            normalizedOptionalString(normalizedClaim, claim, key)
          }
          return normalizedClaim
        }),
      }
      for (const key of ['blockId', 'jurisdictionScope', 'humanReviewNote']) {
        normalizedOptionalString(normalized, finding, key)
      }
      return normalized
    }),
  }
}

export function normalizeFinalizationTransport(value) {
  assertTransportObject(value, FINALIZATION_TRANSPORT_SCHEMA)
  if (!Array.isArray(value.candidates)) throw new RuntimeFailure('deepseek_output_invalid')
  const candidateSchema = FINALIZATION_TRANSPORT_SCHEMA.properties.candidates.items
  return {
    candidates: value.candidates.map((candidate) => {
      assertTransportObject(candidate, candidateSchema)
      const normalized = {
        draftId: candidate.draftId,
        issueType: candidate.issueType,
        ruleType: candidate.ruleType,
        severity: candidate.severity,
        verificationStatus: candidate.verificationStatus,
        retrievalRequired: candidate.retrievalRequired,
        judgement: candidate.judgement,
        suggestion: candidate.suggestion,
        reason: candidate.reason,
        confidence: candidate.confidence,
        temporalContext: candidate.temporalContext,
        disputeStatus: candidate.disputeStatus,
        evidenceClaimIds: candidate.evidenceClaimIds,
      }
      for (const key of ['jurisdictionScope', 'humanReviewNote', 'correctedText']) {
        normalizedOptionalString(normalized, candidate, key)
      }
      return normalized
    }),
  }
}

export function assertScreeningShape(value) {
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

export function locationGate(bundle, findings) {
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

export function assertFinalShape(value, findings) {
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
        instructions: screeningInstructions(skill.policy),
        input: JSON.stringify({ chapter: bundle }), schema: SCREENING_TRANSPORT_SCHEMA, schemaName: 'legal_textbook_screening', reasoningEffort: 'low', maxOutputTokens: STAGE1_MAX_OUTPUT_TOKENS,
      })
      screeningUsage = screening.usage
      const findings = assertScreeningShape(normalizeScreeningTransport(screening.data))
      findingCount = findings.length
      locationGate(bundle, findings)
      const claims = serverClaims(documentId, chapterId, findings)
      retrievalClaimCount = claims.length
      const retrievalResults = await mapConcurrent(claims, RETRIEVAL_CONCURRENCY, (claim) => this.retrievalAdapter.retrieve(claim))
      evidenceFoundCount = retrievalResults.filter((result) => result.status === 'evidence_found').length

      const finalization = await this.modelClient.requestStructured({
        instructions: finalizationInstructions(skill.policy),
        input: JSON.stringify({ chapter: bundle, findings, retrievalResults }), schema: FINALIZATION_TRANSPORT_SCHEMA, schemaName: 'legal_textbook_finalization', reasoningEffort: 'high', maxOutputTokens: STAGE2_MAX_OUTPUT_TOKENS,
      })
      finalizationUsage = finalization.usage
      const finalDrafts = assertFinalShape(normalizeFinalizationTransport(finalization.data), findings)
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
      const providerDiagnostic = {
        ...(error?.upstreamErrorCategory ? { upstreamErrorCategory: error.upstreamErrorCategory } : {}),
        ...(error?.upstreamErrorCode ? { upstreamErrorCode: error.upstreamErrorCode } : {}),
      }
      this.logger.error?.({ provider: status.provider, model: status.model, httpStatus: error?.status, errorCode: code, ...providerDiagnostic, durationMs: error?.durationMs, usage: error?.usage })
      try {
        const current = await this.aiReviewService.get(documentId, chapterId)
        if (current.stage === 'ai_running') {
          await this.aiReviewService.failAiRun(documentId, chapterId, code, current.revision, {
            provider: 'deepseek', model: status.model,
            ...providerDiagnostic,
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
