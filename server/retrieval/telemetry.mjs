import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalizeLegalTitle } from './yuandian/normalize.mjs'

export const MAX_RETRIEVAL_TELEMETRY_BYTES = 32 * 1024
export const MAX_RETRIEVAL_TELEMETRY_FILES = 50_000
export const MAX_TELEMETRY_CANDIDATES = 5
export const MAX_TELEMETRY_PROVIDER_CALLS = 3

const MAX_IDENTIFIER_LENGTH = 160
const MAX_VALUE_LENGTH = 256
const MAX_WARNING_COUNT = 16
const MAX_WARNING_LENGTH = 128
const MAX_SHAPE_KEYS = 32
const MAX_SHAPE_KEY_LENGTH = 64

function limited(value, maxLength = MAX_VALUE_LENGTH) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}

function firstValue(record, fields) {
  for (const field of fields) {
    const value = limited(record?.[field])
    if (value) return value
  }
  return undefined
}

function sha256(value) {
  const normalized = limited(value, 4096)
  return normalized ? createHash('sha256').update(normalized, 'utf8').digest('hex') : undefined
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function safeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value)
    .sort()
    .slice(0, MAX_SHAPE_KEYS)
    .map((key) => key.slice(0, MAX_SHAPE_KEY_LENGTH))
}

export function safeYuandianPayloadShape(payload) {
  const object = Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
  const topLevelKeys = safeKeys(payload)
  const dataPresent = object && Object.hasOwn(payload, 'data')
  const data = dataPresent ? payload.data : undefined
  const dataObject = Boolean(data) && typeof data === 'object' && !Array.isArray(data)
  const nestedDataPresent = dataObject && Object.hasOwn(data, 'data')
  const nestedData = nestedDataPresent ? data.data : undefined
  const normalizedPresent = object && Object.hasOwn(payload, 'normalized')
  const normalized = normalizedPresent ? payload.normalized : undefined
  const okFieldPresent = object && Object.hasOwn(payload, 'ok')
  const statusFieldPresent = object && Object.hasOwn(payload, 'status')
  const messageFieldPresent = object && Object.hasOwn(payload, 'message')
  const shape = {
    topLevelKeys,
    topLevelValueTypes: Object.fromEntries(topLevelKeys.map((key) => [key, valueType(payload[key])])),
    dataPresent,
    dataType: dataPresent ? valueType(data) : 'absent',
    dataKeys: safeKeys(data),
    nestedDataPresent,
    nestedDataType: nestedDataPresent ? valueType(nestedData) : 'absent',
    nestedDataKeys: safeKeys(nestedData),
    normalizedPresent,
    normalizedKeys: safeKeys(normalized),
    okFieldPresent,
    okValueType: okFieldPresent ? valueType(payload.ok) : 'absent',
    statusFieldPresent,
    statusValueType: statusFieldPresent ? valueType(payload.status) : 'absent',
    messageFieldPresent,
    messageLength: messageFieldPresent && typeof payload.message === 'string'
      ? payload.message.length
      : 0,
  }
  return {
    ...shape,
    payloadShapeSha256: createHash('sha256').update(JSON.stringify(shape), 'utf8').digest('hex'),
  }
}

export function createSafeRetrievalTelemetry(claim, recordedAt) {
  const text = typeof claim.text === 'string' ? claim.text : ''
  return {
    schemaVersion: '0.1',
    recordedAt,
    claim: compact({
      claimId: limited(claim.claimId, MAX_IDENTIFIER_LENGTH),
      kind: limited(claim.kind, 64),
      claimTextSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      claimTextLength: text.length,
      knownSourceTitle: limited(claim.knownSourceTitle),
      knownArticleNumber: limited(claim.knownArticleNumber, 96),
      jurisdiction: limited(claim.jurisdiction),
      referenceDate: limited(claim.referenceDate, 32),
    }),
    routing: {},
    providerCallCount: 0,
    providerCalls: [],
    fallbackTriggered: false,
    searchCandidates: [],
    selectedCandidateRank: null,
    detail: {
      detailRecordFound: false,
      rawAuthorityLevelPresent: false,
      jurisdictionPresent: false,
      effectiveDatePresent: false,
      validityPresent: false,
    },
    normalization: { sufficient: false, warnings: [], finalStatus: 'provider_error' },
  }
}

export function recordTelemetryRoute(telemetry, route, searchTool, detailTool) {
  telemetry.routing = compact({
    route: limited(route, 64),
    searchTool: limited(searchTool, 96),
    detailTool: limited(detailTool, 96),
  })
}

export function recordTelemetryProviderCall(telemetry, call) {
  telemetry.providerCallCount += 1
  if (telemetry.providerCalls.length >= MAX_TELEMETRY_PROVIDER_CALLS) return
  telemetry.providerCalls.push(compact({
    tool: limited(call.tool, 96),
    status: limited(call.status, 64),
    resultKind: limited(call.resultKind, 64),
    candidateCount: Number.isSafeInteger(call.candidateCount) && call.candidateCount >= 0
      ? call.candidateCount
      : undefined,
  }))
}

export function updateLastTelemetryProviderCall(telemetry, values) {
  const call = telemetry.providerCalls.at(-1)
  if (!call) return
  if (values.status !== undefined) call.status = limited(values.status, 64)
  if (values.resultKind !== undefined) call.resultKind = limited(values.resultKind, 64)
  if (Number.isSafeInteger(values.candidateCount) && values.candidateCount >= 0) {
    call.candidateCount = values.candidateCount
  }
}

export function safeSearchCandidateTelemetry(candidates) {
  if (!Array.isArray(candidates)) return []
  return candidates.slice(0, MAX_TELEMETRY_CANDIDATES).map((candidate, index) => {
    const title = firstValue(candidate, ['fgmc', 'fgtitle', 'title', 'name'])
    return compact({
      rank: index + 1,
      normalizedTitle: title ? limited(canonicalizeLegalTitle(title)) : undefined,
      articleNumber: firstValue(candidate, ['ftnum', 'ft_num', 'num', 'articleNumber']),
      providerRecordIdSha256: sha256(firstValue(candidate, ['id', 'ftid', 'fgid'])),
      jurisdictionHint: firstValue(candidate, ['dy', 'jurisdiction', 'location']),
    })
  })
}

export function safeDetailTelemetry(record) {
  const rawAuthorityLevel = firstValue(record, [
    'xljb_1', 'xljb_2', 'xljb', 'authorityLevel', 'sourceType',
  ])
  const jurisdiction = firstValue(record, ['dy', 'jurisdiction', 'location'])
  const effectiveDate = firstValue(record, ['ssrq', 'effectiveDate'])
  const validity = firstValue(record, ['sxx', 'validityStatus', 'status'])
  return compact({
    detailRecordFound: Boolean(record),
    returnedTitle: firstValue(record, ['fgmc', 'title', 'name']),
    returnedArticleNumber: firstValue(record, ['ftnum', 'ft_num', 'articleNumber']),
    rawAuthorityLevelPresent: Boolean(rawAuthorityLevel),
    jurisdictionPresent: Boolean(jurisdiction),
    effectiveDatePresent: Boolean(effectiveDate),
    validityPresent: Boolean(validity),
  })
}

export function recordDetailResponseShape(telemetry, payload, field = 'responseShape') {
  const safeField = field === 'fallbackResponseShape' ? field : 'responseShape'
  telemetry.detail[safeField] = safeYuandianPayloadShape(payload)
}

export function finalizeSafeRetrievalTelemetry(telemetry, result, normalized) {
  telemetry.normalization = {
    sufficient: Boolean(normalized?.sufficient),
    warnings: [...new Set(result?.warnings ?? normalized?.warnings ?? [])]
      .filter((warning) => typeof warning === 'string')
      .slice(0, MAX_WARNING_COUNT)
      .map((warning) => warning.slice(0, MAX_WARNING_LENGTH)),
    finalStatus: limited(result?.status, 64) ?? 'provider_error',
  }
  if (result?.error) {
    telemetry.error = compact({
      code: limited(result.error.code, 64),
      providerCode: limited(result.error.providerCode, 128),
      retryable: typeof result.error.retryable === 'boolean' ? result.error.retryable : undefined,
    })
  }
  return telemetry
}

async function countJsonFiles(directory) {
  let count = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countJsonFiles(path.join(directory, entry.name))
    else if (entry.isFile() && entry.name.endsWith('.json')) count += 1
  }
  return count
}

export class FileBackedRetrievalTelemetry {
  constructor(storageRoot, options = {}) {
    this.root = path.resolve(storageRoot, 'metadata', 'retrieval-telemetry')
    this.maxFiles = options.maxFiles ?? MAX_RETRIEVAL_TELEMETRY_FILES
    this.maxBytes = options.maxBytes ?? MAX_RETRIEVAL_TELEMETRY_BYTES
    this.fileCount = 0
    this.initialized = false
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.fileCount = await countJsonFiles(this.root)
    this.initialized = true
  }

  async record(telemetry) {
    if (!this.initialized) await this.init()
    if (this.fileCount >= this.maxFiles) return false
    const body = `${JSON.stringify(telemetry)}\n`
    if (Buffer.byteLength(body, 'utf8') > this.maxBytes) return false
    const day = /^\d{4}-\d{2}-\d{2}/u.exec(telemetry?.recordedAt)?.[0] ?? 'unknown-date'
    const directory = path.join(this.root, day)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const name = `${Date.now()}-${randomUUID()}.json`
    const target = path.join(directory, name)
    const temporary = `${target}.tmp`
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
    this.fileCount += 1
    return true
  }
}
