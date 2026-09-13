import { createHash } from 'node:crypto'
import {
  candidateInvariantErrors,
  candidateSchemaErrors,
  stableCandidateId,
  validateCandidateIssue,
} from '../candidates/candidateContract.mjs'
import { CLAIM_KINDS, validateRetrievalClaim } from '../retrieval/types.mjs'
import { DeepSeekProviderError } from './deepseekResponsesClient.mjs'
import { loadLegalSkillPrompt } from './legalSkillPrompt.mjs'
import {
  CONFIDENCES,
  DISPUTE_STATUSES,
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

export const CANDIDATE_FAILURE_CATEGORIES = Object.freeze([
  'schema_invalid',
  'static_retrieval_mismatch',
  'static_verification_mismatch',
  'verify_retrieval_mismatch',
  'verify_not_required',
  'verify_confirmed_without_verified',
  'verified_without_evidence',
  'low_extraction_status_mismatch',
  'low_extraction_confirmed_error',
  'academic_dispute_confirmed_error',
  'version_resolution_not_explicit',
  'stable_id_mismatch',
  'duplicate_candidate_conflict',
  'unknown_candidate_invariant',
])

export const CANDIDATE_POLICY_NORMALIZATION_CATEGORIES = Object.freeze([
  'static_verification_to_not_required',
  'static_low_extraction_to_manual_check_required',
  'verify_not_required_to_unverified',
  'verified_without_evidence_to_insufficient_evidence',
  'verified_without_evidence_confirmed_to_likely_error',
  'verify_nonverified_confirmed_to_likely_error',
  'academic_dispute_confirmed_to_ambiguous',
  'version_uncertain_verified_to_insufficient_evidence',
  'version_uncertain_confirmed_to_likely_error',
  'low_extraction_to_manual_check_required',
  'low_extraction_confirmed_to_likely_error',
])

export function screeningInstructions(policy) {
  return `${policy}\n\nRuntime rules: screen conservatively; candidate drafts are not final errata; human review is authoritative; do not claim retrieval was performed; protect historical and disputed statements. Every transport field is required. Every finding must reference exactly one existing pdfPage + blockId from the supplied chapter bundle. Copy pdfPage and blockId identifiers exactly. Do not invent block identifiers. The server, not the model, determines source text and extraction reliability. Select the single primary block that best locates the issue. Neighboring blocks may inform judgement, but the finding anchor must be one real block. Use jurisdictionScope, humanReviewNote, and unavailable retrieval claim fields as empty strings; use temporalContext=unspecified and disputeStatus=none or unclear when no stronger value is supported.`
}

export function finalizationInstructions(policy) {
  return `${policy}\n\nRuntime rules: emit only supported candidates; only supplied normalized evidence may support verification; refer to evidence by evidenceClaimIds only; omit uncertain findings; human review remains authoritative. Do not reclassify issueType, ruleType, severity, or retrievalRequired. These fields were fixed during screening and retrieval routing. Decide only whether to retain a finding and its verificationStatus, judgement, suggestion, reason, confidence, evidenceClaimIds, and final contextual qualifications. If evidence shows a finding is not supportable, omit it from candidates; do not change ruleType to cancel it. Every transport field is required. Use jurisdictionScope, humanReviewNote, and correctedText as empty strings; use temporalContext=unspecified, disputeStatus=none, and evidenceClaimIds=[] when appropriate.`
}

class RuntimeFailure extends Error {
  constructor(code, { failurePhase, locationFailureCategory, candidateFailureCategory } = {}) {
    super(locationFailureCategory ? `location_${locationFailureCategory}` : candidateFailureCategory ? `candidate_${candidateFailureCategory}` : code)
    this.code = code
    if (['location_gate', 'candidate_validation'].includes(failurePhase)) this.failurePhase = failurePhase
    if (['page_not_found', 'block_not_found'].includes(locationFailureCategory)) {
      this.locationFailureCategory = locationFailureCategory
    }
    if (CANDIDATE_FAILURE_CATEGORIES.includes(candidateFailureCategory)) {
      this.candidateFailureCategory = candidateFailureCategory
    }
  }
}

function enumValue(value, values) { return typeof value === 'string' && values.includes(value) }
function textValue(value) { return typeof value === 'string' && value.trim().length > 0 }
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
        blockId: finding.blockId,
        issueType: finding.issueType,
        ruleType: finding.ruleType,
        severity: finding.severity,
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
      for (const key of ['jurisdictionScope', 'humanReviewNote']) {
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
        verificationStatus: candidate.verificationStatus,
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
  const findingKeys = ['draftId', 'pdfPage', 'blockId', 'issueType', 'ruleType', 'severity', 'retrievalRequired', 'temporalContext', 'disputeStatus', 'jurisdictionScope', 'suggestionDraft', 'reasonDraft', 'retrievalClaims', 'humanReviewNote']
  const claimKeys = ['kind', 'text', 'knownSourceTitle', 'knownArticleNumber', 'jurisdiction', 'referenceDate']
  let totalClaims = 0
  for (const finding of value.findings) {
    if (!finding || typeof finding !== 'object' || !hasOnlyKeys(finding, findingKeys) || !textValue(finding.draftId) || draftIds.has(finding.draftId) || !Number.isSafeInteger(finding.pdfPage) || finding.pdfPage < 1 || !textValue(finding.blockId) ||
      !enumValue(finding.issueType, ISSUE_TYPES) || !enumValue(finding.ruleType, RULE_TYPES) || !enumValue(finding.severity, SEVERITIES) ||
      !enumValue(finding.retrievalRequired, RETRIEVAL_REQUIREMENTS) || !textValue(finding.suggestionDraft) || !textValue(finding.reasonDraft) ||
      !Array.isArray(finding.retrievalClaims) || finding.retrievalClaims.length > MAX_CLAIMS_PER_FINDING) {
      throw new RuntimeFailure('deepseek_output_invalid')
    }
    if (finding.temporalContext !== undefined && !enumValue(finding.temporalContext, TEMPORAL_CONTEXTS)) throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.disputeStatus !== undefined && !enumValue(finding.disputeStatus, DISPUTE_STATUSES)) throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.ruleType === 'static' && finding.retrievalRequired !== 'no') throw new RuntimeFailure('deepseek_output_invalid')
    if (finding.ruleType === 'verify' && finding.retrievalRequired !== 'must') throw new RuntimeFailure('deepseek_output_invalid')
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

export function hydrateFindingLocation(bundle, finding) {
  const page = bundle.pages.find((candidate) => candidate.pdfPage === finding.pdfPage)
  if (!page || finding.pdfPage < bundle.startPdfPage || finding.pdfPage > bundle.endPdfPage) {
    throw new RuntimeFailure('deepseek_output_invalid', { failurePhase: 'location_gate', locationFailureCategory: 'page_not_found' })
  }
  const block = page.blocks.find((candidate) => candidate.blockId === finding.blockId)
  if (!block) {
    throw new RuntimeFailure('deepseek_output_invalid', { failurePhase: 'location_gate', locationFailureCategory: 'block_not_found' })
  }
  return { ...finding, originalText: block.text, extractionReliability: page.extractionReliability }
}

export function locationGate(bundle, findings) {
  return findings.map((finding) => hydrateFindingLocation(bundle, finding))
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
  const candidateKeys = ['draftId', 'verificationStatus', 'judgement', 'suggestion', 'reason', 'confidence', 'temporalContext', 'disputeStatus', 'jurisdictionScope', 'humanReviewNote', 'correctedText', 'evidenceClaimIds']
  for (const candidate of value.candidates) {
    if (!candidate || typeof candidate !== 'object' || !hasOnlyKeys(candidate, candidateKeys) || !textValue(candidate.draftId) || !knownDrafts.has(candidate.draftId) ||
      !enumValue(candidate.verificationStatus, VERIFICATION_STATUSES) ||
      !enumValue(candidate.judgement, JUDGEMENTS) || !textValue(candidate.suggestion) || !textValue(candidate.reason) ||
      !enumValue(candidate.confidence, CONFIDENCES) || !Array.isArray(candidate.evidenceClaimIds) || new Set(candidate.evidenceClaimIds).size !== candidate.evidenceClaimIds.length) {
      throw new RuntimeFailure('deepseek_output_invalid')
    }
  }
  return value.candidates
}

function candidateFailure(category) {
  return new RuntimeFailure('candidate_validation_failed', { failurePhase: 'candidate_validation', candidateFailureCategory: category })
}

const INVARIANT_FAILURE_CATEGORIES = new Map([
  ['static issue must use retrievalRequired=no', 'static_retrieval_mismatch'],
  ['static issue has inconsistent verificationStatus', 'static_verification_mismatch'],
  ['verify issue must use retrievalRequired=must', 'verify_retrieval_mismatch'],
  ['verify issue cannot use not_required', 'verify_not_required'],
  ['verify issue cannot use confirmed_error without verified status', 'verify_confirmed_without_verified'],
  ['verified issue requires evidence', 'verified_without_evidence'],
  ['low extraction requires manual_check_required', 'low_extraction_status_mismatch'],
  ['low extraction forbids confirmed_error', 'low_extraction_confirmed_error'],
  ['academic dispute must not be confirmed_error', 'academic_dispute_confirmed_error'],
])

function candidateFailureCategory(candidate, errors) {
  if (candidateSchemaErrors(candidate).length) return 'schema_invalid'
  const invariantErrors = candidateInvariantErrors(candidate)
  if (invariantErrors.length) {
    const categories = invariantErrors.map((error) => INVARIANT_FAILURE_CATEGORIES.get(error))
    return categories.every(Boolean) ? categories[0] : 'unknown_candidate_invariant'
  }
  if (errors.some((error) => error === 'candidate id must equal stableCandidateId(candidate)')) return 'stable_id_mismatch'
  return 'unknown_candidate_invariant'
}

export function applyConservativeCandidatePolicy(candidate, { versionResolutionNotExplicit = false } = {}) {
  const normalized = structuredClone(candidate)
  const categories = []
  function set(field, value, category) {
    if (normalized[field] === value) return
    normalized[field] = value
    categories.push(category)
  }

  if (normalized.ruleType === 'static') {
    set(
      'verificationStatus',
      normalized.extractionReliability === 'low' ? 'manual_check_required' : 'not_required',
      normalized.extractionReliability === 'low' ? 'static_low_extraction_to_manual_check_required' : 'static_verification_to_not_required',
    )
  }
  if (normalized.ruleType === 'verify' && normalized.verificationStatus === 'not_required') {
    set('verificationStatus', 'unverified', 'verify_not_required_to_unverified')
  }
  if (normalized.disputeStatus === 'academic_dispute' && normalized.judgement === 'confirmed_error') {
    set('judgement', 'ambiguous', 'academic_dispute_confirmed_to_ambiguous')
  }
  if (normalized.verificationStatus === 'verified' && normalized.evidence.length === 0) {
    set('verificationStatus', 'insufficient_evidence', 'verified_without_evidence_to_insufficient_evidence')
    if (normalized.judgement === 'confirmed_error') set('judgement', 'likely_error', 'verified_without_evidence_confirmed_to_likely_error')
  }
  if (versionResolutionNotExplicit && normalized.verificationStatus === 'verified') {
    set('verificationStatus', 'insufficient_evidence', 'version_uncertain_verified_to_insufficient_evidence')
    if (normalized.judgement === 'confirmed_error') set('judgement', 'likely_error', 'version_uncertain_confirmed_to_likely_error')
  }
  if (normalized.ruleType === 'verify' && normalized.verificationStatus !== 'verified' && normalized.judgement === 'confirmed_error') {
    set('judgement', 'likely_error', 'verify_nonverified_confirmed_to_likely_error')
  }
  if (normalized.extractionReliability === 'low') {
    set('verificationStatus', 'manual_check_required', 'low_extraction_to_manual_check_required')
    if (normalized.judgement === 'confirmed_error') set('judgement', 'likely_error', 'low_extraction_confirmed_to_likely_error')
  }
  return { candidate: normalized, categories }
}

function recordNormalizations(audit, categories) {
  audit.count += categories.length
  for (const category of categories) audit.categories.add(category)
}

function constructCandidates(documentId, chapterId, findings, finalDrafts, retrievalResults, normalizationAudit) {
  const findingById = new Map(findings.map((finding) => [finding.draftId, finding]))
  const resultById = new Map(retrievalResults.map((result) => [result.claimId, result]))
  const candidates = []
  for (const draft of finalDrafts) {
    const finding = findingById.get(draft.draftId)
    const allowedClaimIds = new Set(finding.retrievalClaims.map((claim) => claim.claimId))
    const evidence = []
    let versionResolutionNotExplicit = false
    for (const claimId of draft.evidenceClaimIds) {
      if (!allowedClaimIds.has(claimId)) throw new RuntimeFailure('deepseek_output_invalid')
      const result = resultById.get(claimId)
      if (!result || result.status !== 'evidence_found' || !Array.isArray(result.evidence) || result.evidence.length === 0) {
        throw new RuntimeFailure('deepseek_output_invalid')
      }
      if (result.warnings?.includes('version_resolution_not_explicit')) versionResolutionNotExplicit = true
      evidence.push(...structuredClone(result.evidence))
    }
    const candidate = {
      schemaVersion: '0.1', documentId, chapterId, pdfPage: finding.pdfPage,
      blockId: finding.blockId, originalText: finding.originalText,
      issueType: finding.issueType, ruleType: finding.ruleType, severity: finding.severity,
      extractionReliability: finding.extractionReliability, verificationStatus: draft.verificationStatus,
      retrievalRequired: finding.retrievalRequired, evidence, judgement: draft.judgement,
      suggestion: draft.suggestion, reason: draft.reason, confidence: draft.confidence,
      humanResolution: 'pending',
    }
    for (const key of ['temporalContext', 'disputeStatus', 'jurisdictionScope', 'humanReviewNote', 'correctedText']) optional(candidate, draft, key)
    const normalized = applyConservativeCandidatePolicy(candidate, { versionResolutionNotExplicit })
    recordNormalizations(normalizationAudit, normalized.categories)
    normalized.candidate.id = stableCandidateId(normalized.candidate)
    const validationErrors = validateCandidateIssue(normalized.candidate)
    if (validationErrors.length) throw candidateFailure(candidateFailureCategory(normalized.candidate, validationErrors))
    candidates.push(normalized.candidate)
  }
  const unique = new Map()
  for (const candidate of candidates) {
    const previous = unique.get(candidate.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) throw candidateFailure('duplicate_candidate_conflict')
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
    const normalizationAudit = { count: 0, categories: new Set() }
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
      const screenedFindings = assertScreeningShape(normalizeScreeningTransport(screening.data))
      findingCount = screenedFindings.length
      const findings = locationGate(bundle, screenedFindings)
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
      const candidates = constructCandidates(documentId, chapterId, findings, finalDrafts, retrievalResults, normalizationAudit)
      const current = await this.aiReviewService.get(documentId, chapterId)
      await this.aiReviewService.completeAiRun(documentId, chapterId, candidates, current.revision, {
        provider: 'deepseek', model: this.status().model, skillVersion: skill.skillVersion, skillHash: skill.skillHash,
        coverage, usage: { screening: screeningUsage, finalization: finalizationUsage, total: addUsage(screeningUsage, finalizationUsage) },
        findingCount, retrievalClaimCount, evidenceFoundCount, candidateCount: candidates.length,
        candidatePolicyNormalizationCount: normalizationAudit.count,
        candidatePolicyNormalizationCategories: [...normalizationAudit.categories],
      })
    } catch (error) {
      const code = safeFailureCode(error)
      const status = this.status()
      const providerDiagnostic = {
        ...(error?.upstreamErrorCategory ? { upstreamErrorCategory: error.upstreamErrorCategory } : {}),
        ...(error?.upstreamErrorCode ? { upstreamErrorCode: error.upstreamErrorCode } : {}),
        ...(error?.failurePhase === 'location_gate' ? { failurePhase: error.failurePhase } : {}),
        ...(['page_not_found', 'block_not_found'].includes(error?.locationFailureCategory) ? { locationFailureCategory: error.locationFailureCategory } : {}),
        ...(error?.failurePhase === 'candidate_validation' ? { failurePhase: error.failurePhase } : {}),
        ...(CANDIDATE_FAILURE_CATEGORIES.includes(error?.candidateFailureCategory) ? { candidateFailureCategory: error.candidateFailureCategory } : {}),
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
            candidatePolicyNormalizationCount: normalizationAudit.count,
            candidatePolicyNormalizationCategories: [...normalizationAudit.categories],
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
