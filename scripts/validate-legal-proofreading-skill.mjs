import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidateInvariantErrors as contractInvariantErrors,
  candidateSchemaErrors,
  stableCandidateId as stableIssueId,
} from '../server/candidates/candidateContract.mjs'

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
      ...candidateSchemaErrors(issue),
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
    for (const error of candidateSchemaErrors(issue)) fail(`${golden.caseId}: ${error}`)
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
  if ((forbidden.ruleTypes ?? []).includes(issue.ruleType)) fail(`${golden.caseId}: expected issue uses forbidden ruleType`)
  if ((forbidden.forbiddenJudgements ?? []).includes(issue.judgement)) fail(`${golden.caseId}: expected issue uses forbidden judgement`)
  if ((forbidden.verificationStatuses ?? []).includes(issue.verificationStatus)) fail(`${golden.caseId}: expected issue uses forbidden verificationStatus`)
  if ((forbidden.retrievalRequired ?? []).includes(issue.retrievalRequired)) fail(`${golden.caseId}: expected issue uses forbidden retrievalRequired`)
  if ((forbidden.confidence ?? []).includes(issue.confidence)) fail(`${golden.caseId}: expected issue uses forbidden confidence`)
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

const goldenById = new Map(goldenEntries.map((item) => [item.caseId, item]))
for (const caseId of [
  '17-unicode-homoglyph-rendered-normal',
  '18-compatibility-normalized-equivalent',
  '19-genuine-visible-publisher-typo',
  '20-uncertain-glyph-mapping',
]) {
  if (!caseById.has(caseId) || !goldenById.has(caseId)) fail(`missing extraction-artifact regression ${caseId}`)
}
for (const caseId of ['17-unicode-homoglyph-rendered-normal', '18-compatibility-normalized-equivalent']) {
  if (goldenById.get(caseId)?.expected?.issueExpected !== false) {
    fail(`${caseId}: Unicode-only rendered-normal difference must emit no issue`)
  }
}
const compatibilityCase = caseById.get('18-compatibility-normalized-equivalent')
if (compatibilityCase && compatibilityCase.input?.text.normalize('NFKC') !== compatibilityCase.context?.visiblePageText.normalize('NFKC')) {
  fail('18-compatibility-normalized-equivalent: fixture must be NFKC-equivalent')
}
const genuineTypo = goldenById.get('19-genuine-visible-publisher-typo')?.expected?.expectedIssue
if (
  genuineTypo?.ruleType !== 'static' ||
  genuineTypo?.verificationStatus !== 'not_required' ||
  genuineTypo?.retrievalRequired !== 'no' ||
  genuineTypo?.judgement !== 'confirmed_error'
) {
  fail('19-genuine-visible-publisher-typo: genuine visible typo must remain eligible for static confirmed_error')
}
const uncertainGlyph = goldenById.get('20-uncertain-glyph-mapping')?.expected
if (uncertainGlyph?.issueExpected !== false) {
  fail('20-uncertain-glyph-mapping: extraction-artifact-only glyph suspicion must emit no issue')
}

const recallRebalanceCaseIds = [
  '21-unicode-artifact-only-no-rendered',
  '22-dash-anomaly-manual-review',
  '23-duplicate-text-manual-review',
  '24-repeated-punctuation-manual-review',
  '25-normalization-equivalent-artifact-only',
  '26-normal-language-negative',
]
for (const caseId of recallRebalanceCaseIds) {
  if (!caseById.has(caseId) || !goldenById.has(caseId)) fail(`missing recall-rebalance regression ${caseId}`)
}

for (const caseId of ['21-unicode-artifact-only-no-rendered', '25-normalization-equivalent-artifact-only']) {
  if (goldenById.get(caseId)?.expected?.issueExpected !== false) {
    fail(`${caseId}: extraction-artifact-only suspicion must emit no issue`)
  }
}

const normalizationOnlyCase = caseById.get('25-normalization-equivalent-artifact-only')
if (
  normalizationOnlyCase &&
  normalizationOnlyCase.input?.text.normalize('NFKC') !== normalizationOnlyCase.context?.normalizedReferenceText.normalize('NFKC')
) {
  fail('25-normalization-equivalent-artifact-only: fixture must be NFKC-equivalent')
}

function assertManualReviewRecall(caseId, expectedIssueType) {
  const expected = goldenById.get(caseId)?.expected
  const issue = expected?.expectedIssue
  if (expected?.issueExpected !== true) fail(`${caseId}: actionable anomaly must emit a finding`)
  if (
    issue?.issueType !== expectedIssueType ||
    issue?.ruleType !== 'static' ||
    issue?.verificationStatus !== 'manual_check_required' ||
    issue?.retrievalRequired !== 'no' ||
    issue?.judgement === 'confirmed_error' ||
    issue?.confidence === 'high' ||
    issue?.humanReviewNote !== '需回看 PDF 页面确认，可能存在文本提取或版面映射影响。'
  ) {
    fail(`${caseId}: actionable visual uncertainty must remain conservative and require manual review`)
  }
}

assertManualReviewRecall('22-dash-anomaly-manual-review', 'punctuation')
assertManualReviewRecall('23-duplicate-text-manual-review', 'wording')
assertManualReviewRecall('24-repeated-punctuation-manual-review', 'punctuation')

if (goldenById.get('26-normal-language-negative')?.expected?.issueExpected !== false) {
  fail('26-normal-language-negative: ordinary correct text must emit no issue')
}

const citationMarkerCaseIds = [
  '27-citation-whole-sentence-correct',
  '28-citation-whole-sentence-wrong',
  '29-citation-question-correct',
  '30-citation-question-wrong',
  '31-citation-partial-sentence-correct',
  '32-citation-partial-sentence-wrong',
  '33-citation-quoted-term-correct',
  '34-citation-quoted-term-wrong',
  '35-citation-scope-ambiguous',
  '36-citation-extraction-order-uncertain',
  '37-ordinary-footnote-placement-correct',
  '38-bibliography-identity-not-static',
]
for (const caseId of citationMarkerCaseIds) {
  if (!caseById.has(caseId) || !goldenById.has(caseId)) fail(`missing citation-marker regression ${caseId}`)
}

const citationMarkerNegativeIds = [
  '27-citation-whole-sentence-correct',
  '29-citation-question-correct',
  '31-citation-partial-sentence-correct',
  '33-citation-quoted-term-correct',
  '35-citation-scope-ambiguous',
  '37-ordinary-footnote-placement-correct',
  '38-bibliography-identity-not-static',
]
for (const caseId of citationMarkerNegativeIds) {
  if (goldenById.get(caseId)?.expected?.issueExpected !== false) {
    fail(`${caseId}: citation-marker false-positive guard must emit no issue`)
  }
}

for (const caseId of [
  '28-citation-whole-sentence-wrong',
  '30-citation-question-wrong',
  '32-citation-partial-sentence-wrong',
  '34-citation-quoted-term-wrong',
]) {
  const expected = goldenById.get(caseId)?.expected
  const issue = expected?.expectedIssue
  if (
    expected?.issueExpected !== true ||
    issue?.issueType !== 'citation' ||
    issue?.ruleType !== 'static' ||
    issue?.verificationStatus !== 'not_required' ||
    issue?.retrievalRequired !== 'no' ||
    issue?.judgement !== 'likely_error' ||
    issue?.confidence !== 'medium'
  ) {
    fail(`${caseId}: clear citation-marker placement finding must use the conservative static/no-retrieval classification`)
  }
}

const uncertainCitationMarker = goldenById.get('36-citation-extraction-order-uncertain')?.expected?.expectedIssue
if (
  uncertainCitationMarker?.issueType !== 'citation' ||
  uncertainCitationMarker?.ruleType !== 'static' ||
  uncertainCitationMarker?.extractionReliability !== 'low' ||
  uncertainCitationMarker?.verificationStatus !== 'manual_check_required' ||
  uncertainCitationMarker?.retrievalRequired !== 'no' ||
  uncertainCitationMarker?.judgement === 'confirmed_error' ||
  uncertainCitationMarker?.confidence === 'high' ||
  uncertainCitationMarker?.humanReviewNote !== '需回看 PDF 页面确认引注符号与标点的实际位置及引用范围，可能受文本提取或版面映射影响。'
) {
  fail('36-citation-extraction-order-uncertain: extraction uncertainty must preserve the visual limitation and forbid confirmed_error')
}

const citationPolicy = readFileSync(path.join(skillRoot, 'citation_policy.md'), 'utf8')
for (const requiredText of [
  '## Citation marker placement',
  '**Whole-sentence citation.**',
  '**Partial-sentence citation.**',
  '**Term or direct-quotation citation.**',
  '`ruleType=static`',
  '`retrievalRequired=no`',
]) {
  if (!citationPolicy.includes(requiredText)) fail(`citation_policy.md: missing ${requiredText}`)
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
  console.log('EXTRACTION_FALSE_POSITIVE_GUARD=PASS')
  console.log('ACTIONABLE_PUNCTUATION_RECALL=PASS')
  console.log('DASH_ANOMALY_RECALL=PASS')
  console.log('DUPLICATE_TEXT_RECALL=PASS')
  console.log('NORMAL_TEXT_NO_ISSUE=PASS')
  console.log('CITATION_MARKER_EVAL=PASS')
  console.log('CITATION_MARKER_FALSE_POSITIVE_GUARD=PASS')
  console.log('External calls: none')
}
