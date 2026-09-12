import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillRoot = path.join(repositoryRoot, 'skills', 'legal-textbook-proofreading')
const schemaPath = path.join(skillRoot, 'schema', 'issue.schema.json')
const casesPath = path.join(skillRoot, 'evals', 'cases.jsonl')
const goldenRoot = path.join(skillRoot, 'evals', 'golden')
const verificationFixturesPath = path.join(skillRoot, 'evals', 'verification-invariants.json')
const failures = []

const frozenEnums = {
  issueType: [
    'typo', 'punctuation', 'wording', 'terminology_inconsistency', 'legal_concept',
    'legal_source_mismatch', 'law_status', 'article_number', 'effective_date',
    'historical_context', 'case_claim', 'case_citation', 'data_claim', 'citation',
    'cross_reference', 'overstrong_claim', 'pedagogical_clarification', 'format',
  ],
  ruleType: ['static', 'verify', 'judgement'],
  severity: ['critical', 'major', 'minor', 'clarification'],
  extractionReliability: ['high', 'medium', 'low'],
  verificationStatus: [
    'not_required', 'unverified', 'verified', 'insufficient_evidence', 'manual_check_required',
  ],
  retrievalRequired: ['must', 'should', 'no'],
  judgement: [
    'confirmed_error', 'likely_error', 'ambiguous', 'correct_but_misleading',
    'correct_but_needs_qualification',
  ],
  confidence: ['high', 'medium', 'low'],
  temporalContext: ['current', 'historical', 'mixed', 'unspecified'],
  disputeStatus: ['none', 'academic_dispute', 'judicial_divergence', 'unclear'],
  humanResolution: ['pending', 'accepted', 'modified', 'rejected'],
}

function fail(message) {
  failures.push(message)
}

function parseJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`${path.relative(repositoryRoot, filePath)}: invalid JSON (${error.message})`)
    return null
  }
}

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference: ${reference}`)
  return reference.slice(2).split('/').reduce((value, segment) => value[segment.replaceAll('~1', '/').replaceAll('~0', '~')], rootSchema)
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
  if (rule.const !== undefined && value !== rule.const) errors.push(`${location}: expected constant ${JSON.stringify(rule.const)}`)
  if (rule.enum && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    errors.push(`${location}: unsupported enum value ${JSON.stringify(value)}`)
  }
  if (rule.type && !typeMatches(value, rule.type)) {
    errors.push(`${location}: expected ${rule.type}`)
    return errors
  }
  if (typeof value === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${location}: string is too short`)
    if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) errors.push(`${location}: does not match ${rule.pattern}`)
  }
  if (typeof value === 'number' && rule.minimum !== undefined && value < rule.minimum) {
    errors.push(`${location}: must be >= ${rule.minimum}`)
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${location}: requires at least ${rule.minItems} item(s)`)
    if (rule.items) value.forEach((item, index) => errors.push(...validateValue(item, rule.items, rootSchema, `${location}[${index}]`)))
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
      if (Object.hasOwn(value, key)) errors.push(...validateValue(value[key], propertyRule, rootSchema, `${location}.${key}`))
    }
  }
  for (const nested of rule.allOf ?? []) errors.push(...validateValue(value, nested, rootSchema, location))
  if (rule.if) {
    const conditionErrors = validateValue(value, rule.if, rootSchema, location)
    if (conditionErrors.length === 0 && rule.then) errors.push(...validateValue(value, rule.then, rootSchema, location))
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

function stableIssueId(issue) {
  const textFingerprint = sha256(normalizeOriginalText(issue.originalText))
  const canonical = [
    issue.documentId,
    issue.chapterId,
    String(issue.pdfPage),
    issue.blockId ?? '',
    issue.issueType,
    textFingerprint,
  ].join('\n')
  return `ltp_${sha256(canonical).slice(0, 16)}`
}

function contractInvariantErrors(issue) {
  const errors = []
  if (issue.humanResolution !== 'pending') errors.push('new AI candidate must remain pending')
  if (issue.ruleType === 'static') {
    if (issue.retrievalRequired !== 'no') errors.push('static issue must use retrievalRequired=no')
    const allowedStatus = issue.extractionReliability === 'low' ? 'manual_check_required' : 'not_required'
    if (issue.verificationStatus !== allowedStatus) errors.push('static issue has inconsistent verificationStatus')
  }
  if (issue.ruleType === 'verify') {
    if (issue.retrievalRequired !== 'must') errors.push('verify issue must use retrievalRequired=must')
    if (issue.verificationStatus === 'not_required') errors.push('verify issue cannot use not_required')
    if (issue.verificationStatus !== 'verified' && issue.judgement === 'confirmed_error') {
      errors.push('verify issue cannot use confirmed_error without verified status')
    }
  }
  if (issue.verificationStatus === 'verified' && (!Array.isArray(issue.evidence) || issue.evidence.length === 0)) {
    errors.push('verified issue requires evidence')
  }
  if (issue.extractionReliability === 'low') {
    if (issue.verificationStatus !== 'manual_check_required') errors.push('low extraction requires manual_check_required')
    if (issue.judgement === 'confirmed_error') errors.push('low extraction forbids confirmed_error')
  }
  if (issue.disputeStatus === 'academic_dispute' && issue.judgement === 'confirmed_error') {
    errors.push('academic dispute must not be confirmed_error')
  }
  return errors
}

const companions = [
  'SKILL.md', 'output_contract.md', 'legal_rubric.md', 'citation_policy.md',
  'uncertainty_policy.md', 'schema/issue.schema.json', 'evals/cases.jsonl',
  'evals/golden/cases.golden.json', 'evals/verification-invariants.json',
]
for (const relativePath of companions) {
  if (!existsSync(path.join(skillRoot, relativePath))) fail(`missing companion file: ${relativePath}`)
}

const schema = parseJson(schemaPath)
if (schema) {
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('schema must use JSON Schema Draft 2020-12')
  if (schema.additionalProperties !== false) fail('candidate issue schema must set additionalProperties=false')
  if (Object.hasOwn(schema.properties ?? {}, 'legalRisk')) fail('legalRisk must not exist in v0.1')
  for (const [field, values] of Object.entries(frozenEnums)) {
    const actual = schema.properties?.[field]?.enum
    if (JSON.stringify(actual) !== JSON.stringify(values)) fail(`schema enum drift: ${field}`)
  }
}

const verificationFixtures = parseJson(verificationFixturesPath)
let verificationFixtureCount = 0
if (!Array.isArray(verificationFixtures)) {
  fail('evals/verification-invariants.json: expected an array')
} else if (schema) {
  const baseFixtureIssue = {
    schemaVersion: '0.1',
    id: '',
    documentId: 'doc-synth-guardrail',
    chapterId: 'ch-guardrail',
    pdfPage: 1,
    blockId: 'blk-guardrail',
    originalText: '合成核验不变量测试句。',
    issueType: 'article_number',
    ruleType: 'verify',
    severity: 'major',
    extractionReliability: 'high',
    verificationStatus: 'unverified',
    retrievalRequired: 'must',
    evidence: [],
    judgement: 'likely_error',
    suggestion: '仅用于验证 contract。',
    reason: '该句为合成 fixture，不代表真实法律结论。',
    confidence: 'medium',
    humanResolution: 'pending',
  }
  const fixtureIds = new Set()
  for (const fixture of verificationFixtures) {
    if (typeof fixture?.fixtureId !== 'string' || fixture.fixtureId.length === 0) {
      fail('verification fixture is missing fixtureId')
      continue
    }
    if (fixtureIds.has(fixture.fixtureId)) {
      fail(`duplicate verification fixtureId ${fixture.fixtureId}`)
      continue
    }
    fixtureIds.add(fixture.fixtureId)
    const issue = { ...baseFixtureIssue, ...(fixture.overrides ?? {}) }
    issue.id = stableIssueId(issue)
    const errors = [
      ...validateValue(issue, schema, schema),
      ...contractInvariantErrors(issue),
    ]
    const actualValid = errors.length === 0
    if (typeof fixture.expectedValid !== 'boolean') {
      fail(`${fixture.fixtureId}: expectedValid must be boolean`)
    } else if (actualValid !== fixture.expectedValid) {
      fail(`${fixture.fixtureId}: expected valid=${fixture.expectedValid}, errors=${errors.join('; ') || 'none'}`)
    } else if (!actualValid && fixture.expectedErrorIncludes && !errors.some((error) => error.includes(fixture.expectedErrorIncludes))) {
      fail(`${fixture.fixtureId}: expected error containing ${JSON.stringify(fixture.expectedErrorIncludes)}, got ${errors.join('; ')}`)
    } else {
      verificationFixtureCount += 1
    }
  }
}

const cases = []
if (existsSync(casesPath)) {
  readFileSync(casesPath, 'utf8').split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return
    try {
      cases.push(JSON.parse(line))
    } catch (error) {
      fail(`evals/cases.jsonl:${index + 1}: invalid JSON (${error.message})`)
    }
  })
}

const goldenEntries = []
if (existsSync(goldenRoot)) {
  for (const fileName of readdirSync(goldenRoot).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = parseJson(path.join(goldenRoot, fileName))
    if (!Array.isArray(parsed)) fail(`evals/golden/${fileName}: expected an array`)
    else goldenEntries.push(...parsed)
  }
}

function uniqueById(items, label) {
  const ids = new Set()
  for (const item of items) {
    if (typeof item?.caseId !== 'string' || item.caseId.length === 0) fail(`${label}: missing caseId`)
    else if (ids.has(item.caseId)) fail(`${label}: duplicate caseId ${item.caseId}`)
    else ids.add(item.caseId)
  }
  return ids
}

const caseIds = uniqueById(cases, 'cases')
const goldenIds = uniqueById(goldenEntries, 'golden')
for (const id of caseIds) if (!goldenIds.has(id)) fail(`case ${id}: missing golden entry`)
for (const id of goldenIds) if (!caseIds.has(id)) fail(`golden ${id}: missing input case`)

const caseById = new Map(cases.map((item) => [item.caseId, item]))
const stableIds = new Set()
let positiveCount = 0
let negativeCount = 0

for (const golden of goldenEntries) {
  const testCase = caseById.get(golden.caseId)
  if (!testCase) continue
  const expected = golden.expected
  if (!expected || typeof expected.issueExpected !== 'boolean') {
    fail(`${golden.caseId}: expected.issueExpected must be boolean`)
    continue
  }
  if (!expected.issueExpected) {
    negativeCount += 1
    if (expected.expectedIssue !== null) fail(`${golden.caseId}: negative control must use expectedIssue=null`)
    continue
  }

  positiveCount += 1
  const issue = expected.expectedIssue
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    fail(`${golden.caseId}: positive case requires expectedIssue object`)
    continue
  }
  if (schema) {
    for (const error of validateValue(issue, schema, schema)) fail(`${golden.caseId}: ${error}`)
  }
  for (const [issueField, inputField] of [
    ['documentId', 'documentId'], ['chapterId', 'chapterId'], ['pdfPage', 'pdfPage'],
    ['blockId', 'blockId'], ['originalText', 'text'],
  ]) {
    if (issue[issueField] !== testCase.input?.[inputField]) fail(`${golden.caseId}: ${issueField} does not match input`)
  }
  const computedId = stableIssueId(issue)
  if (issue.id !== computedId) fail(`${golden.caseId}: unstable id; expected ${computedId}`)
  if (stableIds.has(issue.id)) fail(`${golden.caseId}: duplicate stable issue id ${issue.id}`)
  stableIds.add(issue.id)

  for (const error of contractInvariantErrors(issue)) fail(`${golden.caseId}: ${error}`)
  if (issue.verificationStatus === 'verified') fail(`${golden.caseId}: foundation eval must not pretend retrieval occurred`)

  const forbidden = golden.forbidden ?? {}
  if ((forbidden.issueTypes ?? []).includes(issue.issueType)) fail(`${golden.caseId}: expected issue uses forbidden issueType`)
  if ((forbidden.forbiddenJudgements ?? []).includes(issue.judgement)) fail(`${golden.caseId}: expected issue uses forbidden judgement`)
  if ((forbidden.verificationStatuses ?? []).includes(issue.verificationStatus)) fail(`${golden.caseId}: expected issue uses forbidden verificationStatus`)
  if (issue.jurisdictionScope && (forbidden.jurisdictionScopes ?? []).includes(issue.jurisdictionScope)) {
    fail(`${golden.caseId}: expected issue uses forbidden jurisdictionScope`)
  }
}

if (cases.length < 12) fail(`expected at least 12 eval cases, found ${cases.length}`)
if (negativeCount === 0) fail('expected at least one negative control')
const adversarialCount = cases.filter((item) => item.tags?.includes('adversarial')).length

const skillPath = path.join(skillRoot, 'SKILL.md')
if (existsSync(skillPath)) {
  const skill = readFileSync(skillPath, 'utf8')
  for (const heading of ['Purpose', 'Scope', 'Rule Types', 'Review Workflow', 'Retrieval', 'Human Review', 'Output']) {
    if (!(new RegExp(`^## ${heading}\\s*$`, 'imu')).test(skill)) fail(`SKILL.md: missing section ${heading}`)
  }
  if (!/^---\r?\n[\s\S]+?\r?\n---\r?\n/u.test(skill)) fail('SKILL.md: missing YAML frontmatter')
  if (!/^name:\s+legal-textbook-proofreading\s*$/mu.test(skill)) fail('SKILL.md: invalid skill name')
}

if (failures.length > 0) {
  console.error(`Legal proofreading skill validation FAILED (${failures.length})`)
  failures.forEach((message) => console.error(`- ${message}`))
  process.exitCode = 1
} else {
  console.log('Schema validation: PASS')
  console.log('Cross-field validation: PASS')
  console.log(`Verification guardrail fixtures: ${verificationFixtureCount} passed`)
  console.log('Skill lint: PASS')
  console.log(`Eval cases: ${cases.length} (${positiveCount} positive, ${negativeCount} negative controls, ${adversarialCount} adversarial)`)
  console.log(`Stable issue IDs: ${stableIds.size} unique and deterministic`)
  console.log('External calls: none')
}
