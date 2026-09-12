import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './uploadSessionService.mjs'

const SAFE_IDENTIFIER = /^[A-Za-z0-9-]+$/
const SHA256 = /^[a-f0-9]{64}$/i

export class RangeParseError extends Error {
  constructor(fileSize, reason) {
    super(reason)
    this.fileSize = fileSize
  }
}

function failRange(fileSize, reason) {
  throw new RangeParseError(fileSize, reason)
}

/**
 * Parse one RFC 9110 byte range without allocating any part of the file.
 * A missing header means a complete response; every malformed or
 * unsatisfiable range is rejected so multipart ranges cannot be half-supported.
 */
export function parseSingleByteRange(rangeHeader, fileSize) {
  if (rangeHeader === undefined) return null
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error('file size must be a positive safe integer')
  }
  if (typeof rangeHeader !== 'string') failRange(fileSize, 'range header must be a string')

  const header = rangeHeader.trim()
  if (!header.startsWith('bytes=')) failRange(fileSize, 'unsupported range unit')

  const value = header.slice('bytes='.length)
  if (!value || value.includes(',')) failRange(fileSize, 'only one byte range is supported')

  const match = /^(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) failRange(fileSize, 'malformed byte range')

  const size = BigInt(fileSize)
  if (!match[1]) {
    const suffixLength = BigInt(match[2])
    if (suffixLength <= 0n) failRange(fileSize, 'suffix length must be positive')
    const start = suffixLength >= size ? 0n : size - suffixLength
    return { start: Number(start), end: fileSize - 1 }
  }

  const start = BigInt(match[1])
  if (start >= size) failRange(fileSize, 'range starts past the end of the file')

  const requestedEnd = match[2] ? BigInt(match[2]) : size - 1n
  if (requestedEnd < start) failRange(fileSize, 'range end precedes range start')

  const end = requestedEnd >= size ? size - 1n : requestedEnd
  return { start: Number(start), end: Number(end) }
}

function publicInspectionSummary(summary) {
  if (!summary) return null
  return {
    pageCount: summary.pageCount,
    pagesWithText: summary.pagesWithText ?? null,
    pagesWithoutText: summary.pagesWithoutText ?? null,
    scannedPageRatio: summary.scannedPageRatio ?? null,
    warningCount: summary.warningCount ?? 0,
    inspectedAt: summary.inspectedAt,
  }
}

function publicDocument(document) {
  return {
    id: document.id,
    title: document.title,
    originalAssetId: document.originalAssetId,
    pageCount: document.pageCount,
    processingStatus: document.processingStatus,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    inspectionSummary: publicInspectionSummary(document.inspectionSummary),
  }
}

function publicAsset(asset) {
  return {
    id: asset.id,
    documentId: asset.documentId,
    kind: asset.kind,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    createdAt: asset.createdAt,
    immutable: asset.immutable,
  }
}

function publicPage(page) {
  return {
    id: page.id,
    documentId: page.documentId,
    pdfPage: page.pdfPage,
    ...(page.printedPage !== undefined ? { printedPage: page.printedPage } : {}),
    ...(page.chapterId !== undefined ? { chapterId: page.chapterId } : {}),
  }
}

function documentNotFound() {
  return new HttpError(404, 'document_not_found', 'document not found')
}

function assetUnavailable() {
  return new HttpError(500, 'document_asset_unavailable', 'original PDF asset is unavailable')
}

function fileUnavailable() {
  return new HttpError(500, 'document_file_unavailable', 'original PDF file is unavailable')
}

function matchesIfNoneMatch(value, etag) {
  if (typeof value !== 'string') return false
  return value.split(',').some((candidate) => {
    const tag = candidate.trim()
    return tag === '*' || tag === etag || tag === `W/${etag}`
  })
}

function matchesIfRange(value, etag, lastModifiedMs) {
  if (typeof value !== 'string') return false
  const validator = value.trim()

  // If-Range only accepts a strong entity-tag. A weak tag or an invalid
  // validator is deliberately treated as stale so the caller receives 200.
  if (validator.startsWith('W/')) return false
  if (validator.startsWith('"')) return validator === etag

  const dateMs = Date.parse(validator)
  if (!Number.isFinite(dateMs)) return false

  // HTTP dates have one-second precision. Compare at that precision so the
  // Last-Modified value emitted below has the same semantics as this check.
  return Math.floor(lastModifiedMs / 1000) <= Math.floor(dateMs / 1000)
}

export class DocumentReadService {
  constructor({ documentRepository, documentStorage }) {
    this.documentRepository = documentRepository
    this.documentStorage = documentStorage
  }

  async resolveDocument(documentId) {
    if (typeof documentId !== 'string' || !SAFE_IDENTIFIER.test(documentId)) {
      throw documentNotFound()
    }
    const document = await this.documentRepository.getById(documentId)
    if (!document) throw documentNotFound()

    const asset = await this.documentRepository.getAssetForDocument(
      document.id,
      document.originalAssetId,
    )
    if (
      !asset ||
      asset.id !== document.originalAssetId ||
      asset.documentId !== document.id ||
      asset.kind !== 'original-pdf' ||
      asset.mediaType !== 'application/pdf' ||
      asset.immutable !== true ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize <= 0 ||
      !SHA256.test(asset.sha256)
    ) {
      throw assetUnavailable()
    }
    return { document, asset }
  }

  async list() {
    const documents = await this.documentRepository.listDocuments()
    return { documents: documents.map(publicDocument) }
  }

  async detail(documentId) {
    const { document, asset } = await this.resolveDocument(documentId)
    return {
      document: publicDocument(document),
      asset: publicAsset(asset),
      inspectionSummary: publicInspectionSummary(document.inspectionSummary),
    }
  }

  async pages(documentId) {
    const { document } = await this.resolveDocument(documentId)
    const pages = await this.documentRepository.listPages(document.id)
    return { documentId: document.id, pages: pages.map(publicPage) }
  }

  async serveFile(documentId, request, response) {
    const { asset } = await this.resolveDocument(documentId)
    let filePath
    let fileStat
    try {
      filePath = this.documentStorage.resolveAbsolutePath(asset)
      fileStat = await stat(filePath)
    } catch {
      throw fileUnavailable()
    }
    if (!fileStat.isFile() || fileStat.size !== asset.byteSize) throw fileUnavailable()

    const fileSize = fileStat.size
    const etag = `"${asset.sha256.toLowerCase()}"`
    const commonHeaders = {
      'content-type': 'application/pdf',
      'accept-ranges': 'bytes',
      etag,
      'last-modified': fileStat.mtime.toUTCString(),
    }

    // Evaluate If-None-Match before Range. A matching validator means the
    // representation is already fresh, so the correct response is 304 even
    // when the client also supplied a Range header.
    if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
      response.writeHead(304, commonHeaders)
      response.end()
      return
    }

    const rangeHeader = request.headers.range
    const rangeAllowed =
      rangeHeader !== undefined &&
      (request.headers['if-range'] === undefined ||
        matchesIfRange(request.headers['if-range'], etag, fileStat.mtimeMs))

    let range
    try {
      // A stale or unrecognised If-Range is safe fallback-to-full-response
      // behaviour. It must not turn into a 416 for an otherwise valid file.
      range = rangeAllowed ? parseSingleByteRange(rangeHeader, fileSize) : null
    } catch (error) {
      if (error instanceof RangeParseError) {
        throw new HttpError(
          416,
          'range_not_satisfiable',
          'requested byte range is not satisfiable',
          undefined,
          { 'content-range': `bytes */${error.fileSize}` },
        )
      }
      throw error
    }

    const statusCode = range ? 206 : 200
    const start = range?.start ?? 0
    const end = range?.end ?? fileSize - 1
    const headers = {
      ...commonHeaders,
      'content-length': String(end - start + 1),
      ...(range ? { 'content-range': `bytes ${start}-${end}/${fileSize}` } : {}),
    }
    response.writeHead(statusCode, headers)
    if (request.method === 'HEAD') {
      response.end()
      return
    }

    const content = this.documentStorage.read(asset, range ? { start, end } : undefined)
    await pipeline(content, response)
  }
}
