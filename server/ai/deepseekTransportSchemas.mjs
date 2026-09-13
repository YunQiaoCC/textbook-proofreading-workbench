import { candidateIssueTypes } from '../candidates/candidateContract.mjs'
import { CLAIM_KINDS } from '../retrieval/types.mjs'

export const ISSUE_TYPES = Object.freeze(candidateIssueTypes())
export const RULE_TYPES = Object.freeze(['static', 'verify', 'judgement'])
export const SEVERITIES = Object.freeze(['critical', 'major', 'minor', 'clarification'])
export const EXTRACTION_RELIABILITIES = Object.freeze(['high', 'medium', 'low'])
export const RETRIEVAL_REQUIREMENTS = Object.freeze(['must', 'should', 'no'])
export const TEMPORAL_CONTEXTS = Object.freeze(['current', 'historical', 'mixed', 'unspecified'])
export const DISPUTE_STATUSES = Object.freeze(['none', 'academic_dispute', 'judicial_divergence', 'unclear'])
export const VERIFICATION_STATUSES = Object.freeze(['not_required', 'unverified', 'verified', 'insufficient_evidence', 'manual_check_required'])
export const JUDGEMENTS = Object.freeze(['confirmed_error', 'likely_error', 'ambiguous', 'correct_but_misleading', 'correct_but_needs_qualification'])
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low'])

const retrievalClaimTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text', 'knownSourceTitle', 'knownArticleNumber', 'jurisdiction', 'referenceDate'],
  properties: {
    kind: { type: 'string', enum: CLAIM_KINDS },
    text: { type: 'string' },
    knownSourceTitle: { type: 'string' },
    knownArticleNumber: { type: 'string' },
    jurisdiction: { type: 'string' },
    referenceDate: { type: 'string' },
  },
}

const screeningFindingTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'draftId', 'pdfPage', 'blockId', 'issueType', 'ruleType', 'severity',
    'retrievalRequired', 'temporalContext', 'disputeStatus',
    'jurisdictionScope', 'suggestionDraft', 'reasonDraft', 'retrievalClaims', 'humanReviewNote',
  ],
  properties: {
    draftId: { type: 'string' },
    pdfPage: { type: 'integer' },
    blockId: { type: 'string' },
    issueType: { type: 'string', enum: ISSUE_TYPES },
    ruleType: { type: 'string', enum: RULE_TYPES },
    severity: { type: 'string', enum: SEVERITIES },
    retrievalRequired: { type: 'string', enum: RETRIEVAL_REQUIREMENTS },
    temporalContext: { type: 'string', enum: TEMPORAL_CONTEXTS },
    disputeStatus: { type: 'string', enum: DISPUTE_STATUSES },
    jurisdictionScope: { type: 'string' },
    suggestionDraft: { type: 'string' },
    reasonDraft: { type: 'string' },
    retrievalClaims: { type: 'array', items: retrievalClaimTransportSchema },
    humanReviewNote: { type: 'string' },
  },
}

export const SCREENING_TRANSPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: { type: 'array', items: screeningFindingTransportSchema },
  },
}

const finalCandidateTransportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'draftId', 'verificationStatus', 'judgement', 'suggestion', 'reason', 'confidence',
    'temporalContext', 'disputeStatus',
    'jurisdictionScope', 'humanReviewNote', 'correctedText', 'evidenceClaimIds',
  ],
  properties: {
    draftId: { type: 'string' },
    verificationStatus: { type: 'string', enum: VERIFICATION_STATUSES },
    judgement: { type: 'string', enum: JUDGEMENTS },
    suggestion: { type: 'string' },
    reason: { type: 'string' },
    confidence: { type: 'string', enum: CONFIDENCES },
    temporalContext: { type: 'string', enum: TEMPORAL_CONTEXTS },
    disputeStatus: { type: 'string', enum: DISPUTE_STATUSES },
    jurisdictionScope: { type: 'string' },
    humanReviewNote: { type: 'string' },
    correctedText: { type: 'string' },
    evidenceClaimIds: { type: 'array', items: { type: 'string' } },
  },
}

export const FINALIZATION_TRANSPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: { type: 'array', items: finalCandidateTransportSchema },
  },
}
