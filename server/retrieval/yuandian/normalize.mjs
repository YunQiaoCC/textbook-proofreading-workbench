import { RetrievalProviderError } from '../errors.mjs'
import { isHistoricalClaim } from '../types.mjs'

const SOURCE_TYPE_MAP = new Map([
  ['法律', 'law'],
  ['行政法规', 'administrative_regulation'],
  ['司法解释', 'judicial_interpretation'],
  ['部门规章', 'department_rule'],
  ['地方性法规', 'local_regulation'],
  ['自治条例和单行条例', 'local_regulation'],
  ['地方政府规章', 'local_regulation'],
  ['普通规范性文件', 'normative_document'],
])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstValue(record, fields) {
  for (const field of fields) {
    const value = nonEmpty(record?.[field])
    if (value) return value
  }
  return undefined
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function comparable(value) {
  return nonEmpty(value)?.replace(/[《》\s]/gu, '')
}

const LEGAL_TITLE_WITH_OPTIONAL_REVISION_SUFFIX =
  /^《([^《》]+)》(?=(?:\((?:18|19|20)\d{2}年?(?:修正|修订)\))?$)/u
const LEGAL_TITLE_REVISION_SUFFIX = /^(.+)\(((?:18|19|20)\d{2})年?(修正|修订)\)$/u
const PROMULGATION_NOTICE_TITLE =
  /^.{1,80}(?:颁发|颁布|发布|公布|印发)《([^《》]+)》(?:的)?通知$/u
const NATIONAL_TITLE_PREFIX = /^中华人民共和国/u
const ARTICLE_COMPONENT = /(?:第)?([0-9〇零一二三四五六七八九十百千万两]+)(条|款|项)/gu

const CHINESE_DIGITS = new Map([
  ['〇', 0], ['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4],
  ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9],
])
const CHINESE_UNITS = new Map([['十', 10], ['百', 100], ['千', 1000]])

function parseChineseInteger(value) {
  if (/^\d+$/u.test(value)) return String(Number(value))
  if (![...value].some((character) => CHINESE_UNITS.has(character) || character === '万')) {
    const digits = [...value].map((character) => CHINESE_DIGITS.get(character))
    return digits.every((digit) => digit !== undefined) ? String(Number(digits.join(''))) : undefined
  }
  let total = 0
  let section = 0
  let digit = 0
  for (const character of value) {
    if (CHINESE_DIGITS.has(character)) {
      digit = CHINESE_DIGITS.get(character)
      continue
    }
    if (CHINESE_UNITS.has(character)) {
      section += (digit || 1) * CHINESE_UNITS.get(character)
      digit = 0
      continue
    }
    if (character === '万') {
      total += (section + digit || 1) * 10_000
      section = 0
      digit = 0
      continue
    }
    return undefined
  }
  return String(total + section + digit)
}

export function canonicalizeLegalTitle(value) {
  const raw = nonEmpty(value)
  if (!raw) return undefined
  const canonical = raw
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(LEGAL_TITLE_WITH_OPTIONAL_REVISION_SUFFIX, '$1')
  return canonical.replace(PROMULGATION_NOTICE_TITLE, '$1')
}

function legalTitleParts(value) {
  const canonical = canonicalizeLegalTitle(value)
  if (!canonical) return undefined
  const match = LEGAL_TITLE_REVISION_SUFFIX.exec(canonical)
  if (!match) return { canonical, base: canonical, revisionSuffix: undefined }
  return {
    canonical,
    base: match[1],
    revisionSuffix: { year: match[2], kind: match[3] },
  }
}

export function sameLegalTitle(left, right) {
  const leftParts = legalTitleParts(left)
  const rightParts = legalTitleParts(right)
  if (!leftParts || !rightParts) return false
  if (leftParts.canonical === rightParts.canonical) return true
  const leftBase = leftParts.base.replace(NATIONAL_TITLE_PREFIX, '')
  const rightBase = rightParts.base.replace(NATIONAL_TITLE_PREFIX, '')
  if (leftParts.base !== rightParts.base && leftBase !== rightBase) return false
  // A base title may identify the same instrument as one explicitly carrying
  // the observed revision suffix. Two different explicit revisions are not
  // collapsed because version identity remains independently significant.
  if (!leftParts.revisionSuffix || !rightParts.revisionSuffix) return true
  return leftParts.revisionSuffix.year === rightParts.revisionSuffix.year &&
    leftParts.revisionSuffix.kind === rightParts.revisionSuffix.kind
}

export function canonicalizeArticleNumber(value) {
  const raw = nonEmpty(value)?.normalize('NFKC').replace(/\s+/gu, '')
  if (!raw) return undefined
  const bare = /^(?:第)?([0-9〇零一二三四五六七八九十百千万两]+)$/u.exec(raw)
  if (bare) {
    const number = parseChineseInteger(bare[1])
    return number === undefined ? undefined : `article:${number}`
  }
  const components = []
  let consumed = ''
  for (const match of raw.matchAll(ARTICLE_COMPONENT)) {
    consumed += match[0]
    const number = parseChineseInteger(match[1])
    if (number === undefined) return undefined
    const type = { 条: 'article', 款: 'paragraph', 项: 'item' }[match[2]]
    components.push(`${type}:${number}`)
  }
  return components.length && consumed === raw ? components.join('|') : undefined
}

export function sameArticleNumber(left, right) {
  const leftCanonical = canonicalizeArticleNumber(left)
  const rightCanonical = canonicalizeArticleNumber(right)
  if (leftCanonical && rightCanonical) return leftCanonical === rightCanonical
  return Boolean(comparable(left)) && comparable(left) === comparable(right)
}

export function mapYuandianSourceType(rawAuthorityLevel) {
  const raw = nonEmpty(rawAuthorityLevel)
  const sourceType = SOURCE_TYPE_MAP.get(raw) ?? 'other'
  const limitations = []
  if (raw === '地方政府规章') limitations.push('normalized from local government rule')
  if (sourceType === 'other') limitations.push(`rawAuthorityLevel: ${raw ?? 'not provided'}`)
  else if (raw === '地方政府规章') limitations.push(`rawAuthorityLevel: ${raw}`)
  return {
    sourceType,
    authorityAxis: sourceType === 'other' ? 'other' : 'normative',
    limitations,
  }
}

export function readYuandianPayload(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Runtime-observed contracts are checked before the explicit legacy-compatible
// paths. Keep both lists finite: retrieval must never guess that an arbitrary
// nested array contains legal candidates.
const OBSERVED_SEARCH_COLLECTION_PATHS = Object.freeze([
  Object.freeze(['data', 'data']),
  Object.freeze(['data', 'extra', 'fatiao']),
])

const LEGACY_SEARCH_COLLECTION_PATHS = Object.freeze([
  Object.freeze([]),
  Object.freeze(['data']),
  Object.freeze(['results']),
  Object.freeze(['records']),
  Object.freeze(['items']),
  Object.freeze(['list']),
  Object.freeze(['data', 'results']),
  Object.freeze(['data', 'records']),
  Object.freeze(['data', 'items']),
  Object.freeze(['data', 'list']),
  Object.freeze(['results', 'results']),
  Object.freeze(['results', 'records']),
  Object.freeze(['results', 'items']),
  Object.freeze(['results', 'list']),
  Object.freeze(['records', 'results']),
  Object.freeze(['records', 'records']),
  Object.freeze(['records', 'items']),
  Object.freeze(['records', 'list']),
  Object.freeze(['items', 'results']),
  Object.freeze(['items', 'records']),
  Object.freeze(['items', 'items']),
  Object.freeze(['items', 'list']),
  Object.freeze(['list', 'results']),
  Object.freeze(['list', 'records']),
  Object.freeze(['list', 'items']),
  Object.freeze(['list', 'list']),
])

const OBSERVED_DETAIL_RECORD_PATH = Object.freeze(['data', 'data'])
const LEGACY_DETAIL_RECORD_PATHS = Object.freeze([
  Object.freeze(['data']),
  Object.freeze(['result']),
  Object.freeze(['record']),
  Object.freeze(['detail']),
])

const LEGACY_DETAIL_MARKER_FIELDS = Object.freeze([
  'id', 'ftid', 'fgid', 'fgmc', 'title', 'name', 'content', 'ftnr',
])

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasPath(payload, path) {
  let value = payload
  for (const field of path) {
    if (!plainObject(value) || !Object.hasOwn(value, field)) return false
    value = value[field]
  }
  return true
}

function valueAtPath(payload, path) {
  let value = payload
  for (const field of path) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, field)) return undefined
    value = value[field]
  }
  return value
}

function unsupportedResponseShape() {
  return new RetrievalProviderError('provider_error', {
    providerCode: 'unsupported_response_shape',
    retryable: false,
  })
}

function observedNotFound(payload) {
  if (!plainObject(payload)) return false
  const wrapperFields = ['data', 'normalized', 'ok', 'requestId', 'routeKey', 'status', 'tool']
  for (const field of wrapperFields) {
    if (!Object.hasOwn(payload, field)) return false
  }
  if (Object.keys(payload).some((field) => !wrapperFields.includes(field))) return false
  if (typeof payload.ok !== 'boolean') return false
  if (typeof payload.requestId !== 'string' || typeof payload.routeKey !== 'string') return false
  if (typeof payload.status !== 'number' || typeof payload.tool !== 'string') return false
  if (!plainObject(payload.data)) return false
  if (Object.hasOwn(payload.data, 'data')) return false
  if (!Object.hasOwn(payload.data, 'message') || !Object.hasOwn(payload.data, 'status')) return false
  if (Object.keys(payload.data).some((field) => !['message', 'status'].includes(field))) return false
  if (!plainObject(payload.normalized)) return false
  if (Object.keys(payload.normalized).some((field) => !['hasItems', 'itemCount', 'items', 'resultPath'].includes(field))) {
    return false
  }
  if (!Array.isArray(payload.normalized.items) || payload.normalized.items.length !== 0) return false
  if (payload.normalized.resultPath !== null) return false
  if (typeof payload.normalized.hasItems !== 'boolean') return false
  if (typeof payload.normalized.itemCount !== 'number') return false
  return true
}

export function classifyYuandianSearchPayload(payload) {
  for (const path of OBSERVED_SEARCH_COLLECTION_PATHS) {
    if (!hasPath(payload, path)) continue
    const candidate = valueAtPath(payload, path)
    if (!Array.isArray(candidate)) throw unsupportedResponseShape()
    return { kind: 'candidates', candidates: candidate }
  }
  for (const path of LEGACY_SEARCH_COLLECTION_PATHS) {
    const candidate = valueAtPath(payload, path)
    if (Array.isArray(candidate)) return { kind: 'candidates', candidates: candidate }
  }
  if (observedNotFound(payload)) return { kind: 'not_found', candidates: [] }
  throw unsupportedResponseShape()
}

export function searchCandidates(payload) {
  return classifyYuandianSearchPayload(payload).candidates
}

function legacyDetailRecord(value) {
  const record = Array.isArray(value) ? value[0] : value
  if (!plainObject(record)) return undefined
  return LEGACY_DETAIL_MARKER_FIELDS.some((field) => Object.hasOwn(record, field))
    ? record
    : undefined
}

export function detailRecord(payload) {
  if (hasPath(payload, OBSERVED_DETAIL_RECORD_PATH)) {
    const record = valueAtPath(payload, OBSERVED_DETAIL_RECORD_PATH)
    if (!plainObject(record)) throw unsupportedResponseShape()
    return record
  }
  for (const path of LEGACY_DETAIL_RECORD_PATHS) {
    if (!hasPath(payload, path)) continue
    const record = legacyDetailRecord(valueAtPath(payload, path))
    if (record) return record
  }
  throw unsupportedResponseShape()
}

function supportSummary(claim, title, record) {
  const quotedTitle = title.startsWith('《') ? title : `《${title}》`
  const articleNumber = firstValue(record, ['ftnum', 'ft_num', 'articleNumber']) ?? claim.knownArticleNumber
  const effectiveDate = firstValue(record, ['ssrq', 'effectiveDate'])
  const validity = firstValue(record, ['sxx', 'validityStatus', 'status'])

  if (claim.kind === 'effective_date' && effectiveDate) {
    return `该来源记录${quotedTitle}的施行日期为 ${effectiveDate}。`
  }
  if (claim.kind === 'legal_status' && validity) {
    return `该来源记录${quotedTitle}的效力状态为“${validity}”。`
  }
  if (claim.kind === 'historical_version') {
    return `该来源提供${quotedTitle}在 ${claim.referenceDate} 历史时点的详情，可用于核验该历史命题。`
  }
  if (articleNumber) {
    return `该来源提供${quotedTitle}${articleNumber}的法条详情，可用于核验所述条文命题。`
  }
  return `该来源提供${quotedTitle}的法规详情，可用于核验所述法律命题。`
}

export function normalizeYuandianDetail({ claim, record, searchCandidate, providerTool, retrievedAt }) {
  const warnings = []
  // xljb_1 is the observed first-level authority classification. xljb_2 is
  // accepted only as a defensive fallback; unknown secondary values remain
  // `other` rather than being coerced into a stronger source type.
  const rawAuthorityLevel = firstValue(record, [
    'xljb_1', 'xljb_2', 'xljb', 'authorityLevel', 'sourceType',
  ])
  const mapping = mapYuandianSourceType(rawAuthorityLevel)
  const title = firstValue(record, ['fgmc', 'title', 'name'])
  const articleNumber = firstValue(record, ['ftnum', 'ft_num', 'articleNumber'])
  const detailJurisdiction = firstValue(record, ['dy', 'jurisdiction', 'location'])
  const candidateJurisdiction = firstValue(searchCandidate, ['dy', 'jurisdiction', 'location'])
  const publicationDate = firstValue(record, ['fbrq', 'publicationDate'])
  const effectiveDate = firstValue(record, ['ssrq', 'effectiveDate'])
  const validity = firstValue(record, ['sxx', 'validityStatus', 'status'])
  const resolvedVersionDate = firstValue(record, ['versionDate', 'version_date', 'xdrq']) ?? null
  const historicalRequest = isHistoricalClaim(claim)
  let sufficient = true

  if (!title || (claim.knownSourceTitle && !sameLegalTitle(title, claim.knownSourceTitle))) {
    warnings.push('target_not_confirmed')
    sufficient = false
  }
  if (claim.knownArticleNumber && !sameArticleNumber(articleNumber, claim.knownArticleNumber)) {
    warnings.push('article_number_not_confirmed')
    sufficient = false
  }
  if (!rawAuthorityLevel) {
    warnings.push('authority_not_confirmed')
    sufficient = false
  }
  if (!detailJurisdiction) warnings.push('jurisdiction_not_confirmed')
  if ((claim.jurisdiction || claim.kind === 'jurisdiction') && !detailJurisdiction) sufficient = false
  if (claim.jurisdiction && detailJurisdiction && comparable(claim.jurisdiction) !== comparable(detailJurisdiction)) {
    warnings.push('jurisdiction_mismatch')
    sufficient = false
  }
  if (historicalRequest && !resolvedVersionDate) {
    warnings.push('version_resolution_not_explicit')
  }

  const limitations = [...mapping.limitations]
  if (effectiveDate) limitations.push(`effective date (schema gap): ${effectiveDate}`)
  if (historicalRequest && !resolvedVersionDate) {
    limitations.push('provider did not explicitly identify the resolved version date')
  }

  const evidence = title ? compact({
    sourceType: mapping.sourceType,
    authorityAxis: mapping.authorityAxis,
    title,
    issuerOrAuthor: firstValue(record, ['fbbm', 'issuerOrAuthor', 'issuer']),
    citationOrUrl: firstValue(record, ['url', 'citationOrUrl']),
    supports: supportSummary(claim, title, record),
    publicationDate,
    effectiveStatus: validity,
    jurisdiction: detailJurisdiction,
    limitations: limitations.length ? limitations.join('; ') : undefined,
  }) : null

  const provenance = compact({
    provider: 'yuandian-law',
    providerTool,
    providerRecordId: firstValue(record, ['id', 'ftid', 'fgid']),
    retrievedAt,
    query: claim.knownSourceTitle ?? claim.text,
    referenceDate: claim.referenceDate,
    requestedReferDate: historicalRequest
      ? claim.referenceDate
      : undefined,
    resolvedVersionDate,
    rawValidityStatus: validity,
    rawAuthorityLevel,
    effectiveDate,
    searchCandidateJurisdictionHint: candidateJurisdiction,
  })

  return { evidence, provenance, warnings, sufficient: sufficient && Boolean(evidence) }
}
