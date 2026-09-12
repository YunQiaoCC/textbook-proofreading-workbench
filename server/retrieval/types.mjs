export const RETRIEVAL_PROVIDER = 'yuandian-law'

export const CLAIM_KINDS = Object.freeze([
  'statute_identity',
  'article_text',
  'article_number',
  'legal_status',
  'effective_date',
  'historical_version',
  'jurisdiction',
  'normative_proposition',
])

export const RETRIEVAL_RESULT_STATUSES = Object.freeze([
  'evidence_found',
  'insufficient_evidence',
  'not_found',
  'provider_unavailable',
  'provider_error',
])

const TEMPORAL_CONTEXTS = new Set(['current', 'historical', 'mixed', 'unspecified'])
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validIsoDate(value) {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

export function isHistoricalClaim(claim) {
  return claim.kind === 'historical_version' || ['historical', 'mixed'].includes(claim.temporalContext)
}

export function validateRetrievalClaim(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('claim must be an object')
  }
  if (!nonEmptyString(input.claimId)) throw new TypeError('claimId must be a non-empty string')
  if (!CLAIM_KINDS.includes(input.kind)) throw new TypeError('unsupported claim kind')
  if (!nonEmptyString(input.text) && !nonEmptyString(input.knownSourceTitle)) {
    throw new TypeError('claim requires text or knownSourceTitle')
  }
  if (input.temporalContext !== undefined && !TEMPORAL_CONTEXTS.has(input.temporalContext)) {
    throw new TypeError('unsupported temporalContext')
  }
  if (input.referenceDate !== undefined && !validIsoDate(input.referenceDate)) {
    throw new TypeError('referenceDate must use YYYY-MM-DD')
  }
  if (isHistoricalClaim(input) && !validIsoDate(input.referenceDate ?? '')) {
    throw new TypeError('historical claims require referenceDate')
  }
  for (const field of ['documentId', 'chapterId', 'jurisdiction', 'knownSourceTitle', 'knownArticleNumber']) {
    if (input[field] !== undefined && !nonEmptyString(input[field])) {
      throw new TypeError(`${field} must be a non-empty string when provided`)
    }
  }
  if (input.pdfPage !== undefined && (!Number.isSafeInteger(input.pdfPage) || input.pdfPage < 1)) {
    throw new TypeError('pdfPage must be a positive integer when provided')
  }
  return { ...input, claimId: input.claimId.trim(), text: input.text?.trim() }
}

export function createRetrievalResult(claimId, values = {}) {
  return {
    status: values.status ?? 'insufficient_evidence',
    provider: RETRIEVAL_PROVIDER,
    claimId,
    evidence: values.evidence ?? [],
    provenance: values.provenance ?? null,
    warnings: [...new Set(values.warnings ?? [])],
    ...(values.error ? { error: values.error } : {}),
  }
}
