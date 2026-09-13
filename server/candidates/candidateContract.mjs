import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const CANDIDATE_SCHEMA_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'skills',
  'legal-textbook-proofreading',
  'schema',
  'issue.schema.json',
)

const candidateSchema = JSON.parse(readFileSync(CANDIDATE_SCHEMA_PATH, 'utf8'))

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference: ${reference}`)
  return reference.slice(2).split('/').reduce(
    (value, segment) => value[segment.replaceAll('~1', '/').replaceAll('~0', '~')],
    rootSchema,
  )
}

function typeMatches(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isSafeInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string') return typeof value === 'string'
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  return true
}

function validateValue(value, rule, rootSchema, location = '$') {
  const errors = []
  if (rule.$ref) return validateValue(value, resolveRef(rootSchema, rule.$ref), rootSchema, location)
  if (rule.const !== undefined && value !== rule.const) {
    errors.push(`${location}: expected constant ${JSON.stringify(rule.const)}`)
  }
  if (rule.enum && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${location}: unsupported enum value ${JSON.stringify(value)}`)
  }
  if (rule.type && !typeMatches(value, rule.type)) {
    errors.push(`${location}: expected ${rule.type}`)
    return errors
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push(`${location}: string is too short`)
    }
    if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) {
      errors.push(`${location}: does not match ${rule.pattern}`)
    }
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) {
    errors.push(`${location}: must be >= ${rule.minimum}`)
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) {
      errors.push(`${location}: requires at least ${rule.minItems} item(s)`)
    }
    if (rule.items) {
      value.forEach((item, index) => {
        errors.push(...validateValue(item, rule.items, rootSchema, `${location}[${index}]`))
      })
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of rule.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${location}: missing required property ${required}`)
    }
    if (rule.additionalProperties === false && rule.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(rule.properties, key)) errors.push(`${location}: unexpected property ${key}`)
      }
    }
    for (const [key, propertyRule] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateValue(value[key], propertyRule, rootSchema, `${location}.${key}`))
      }
    }
  }
  for (const nested of rule.allOf ?? []) {
    errors.push(...validateValue(value, nested, rootSchema, location))
  }
  if (rule.if) {
    const conditionErrors = validateValue(value, rule.if, rootSchema, location)
    if (conditionErrors.length === 0 && rule.then) {
      errors.push(...validateValue(value, rule.then, rootSchema, location))
    }
  }
  if (rule.not && validateValue(value, rule.not, rootSchema, location).length === 0) {
    errors.push(`${location}: matches a forbidden schema`)
  }
  return errors
}

function normalizeOriginalText(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function stableCandidateId(candidate) {
  const textFingerprint = sha256(normalizeOriginalText(candidate.originalText))
  const canonical = [
    candidate.documentId,
    candidate.chapterId,
    String(candidate.pdfPage),
    candidate.blockId ?? '',
    candidate.issueType,
    textFingerprint,
  ].join('\n')
  return `ltp_${sha256(canonical).slice(0, 16)}`
}

export function candidateInvariantErrors(candidate) {
  const errors = []
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return errors
  if (candidate.humanResolution !== 'pending') errors.push('new AI candidate must remain pending')
  if (candidate.ruleType === 'static') {
    if (candidate.retrievalRequired !== 'no') errors.push('static issue must use retrievalRequired=no')
    const allowedStatus = candidate.extractionReliability === 'low'
      ? 'manual_check_required'
      : 'not_required'
    if (candidate.verificationStatus !== allowedStatus) {
      errors.push('static issue has inconsistent verificationStatus')
    }
  }
  if (candidate.ruleType === 'verify') {
    if (candidate.retrievalRequired !== 'must') errors.push('verify issue must use retrievalRequired=must')
    if (candidate.verificationStatus === 'not_required') {
      errors.push('verify issue cannot use not_required')
    }
    if (candidate.verificationStatus !== 'verified' && candidate.judgement === 'confirmed_error') {
      errors.push('verify issue cannot use confirmed_error without verified status')
    }
  }
  if (
    candidate.verificationStatus === 'verified' &&
    (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0)
  ) {
    errors.push('verified issue requires evidence')
  }
  if (candidate.extractionReliability === 'low') {
    if (candidate.verificationStatus !== 'manual_check_required') {
      errors.push('low extraction requires manual_check_required')
    }
    if (candidate.judgement === 'confirmed_error') {
      errors.push('low extraction forbids confirmed_error')
    }
  }
  if (candidate.disputeStatus === 'academic_dispute' && candidate.judgement === 'confirmed_error') {
    errors.push('academic dispute must not be confirmed_error')
  }
  return errors
}

export function candidateSchemaErrors(candidate) {
  return validateValue(candidate, candidateSchema, candidateSchema)
}

export function validateCandidateIssue(candidate) {
  const errors = [
    ...candidateSchemaErrors(candidate),
    ...candidateInvariantErrors(candidate),
  ]
  if (errors.length === 0 && candidate.id !== stableCandidateId(candidate)) {
    errors.push(`candidate id must equal stableCandidateId(candidate)`)
  }
  return errors
}

export function candidateIssueTypes() {
  return [...candidateSchema.properties.issueType.enum]
}
