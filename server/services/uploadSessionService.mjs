import { access, link, readdir, rm, stat, open } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createReadStream as openReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { atomicWriteJson, ensureDirectory, readJson, removeDirectory } from '../utils/fs.mjs'

const SESSION_FILE = 'session.json'
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000

export class HttpError extends Error {
  constructor(statusCode, code, message, details) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

function safeSessionId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
}

function safePartNumber(value) {
  return Number.isInteger(value) && value > 0
}

function displayFilename(filename) {
  const normalized = filename.trim().replaceAll('\\', '/')
  const basename = path.posix.basename(normalized)
  if (!basename || basename === '.' || basename === '..') {
    throw new HttpError(400, 'invalid_filename', 'filename must contain a usable file name')
  }
  return basename.slice(0, 255)
}

function expectedPartSize(session, partNumber) {
  const start = (partNumber - 1) * session.chunkSize
  return Math.min(session.chunkSize, session.declaredByteSize - start)
}

function publicSession(session) {
  return {
    id: session.id,
    originalFilename: session.originalFilename,
    declaredByteSize: session.declaredByteSize,
    chunkSize: session.chunkSize,
    expectedParts: session.expectedParts,
    receivedParts: [...session.receivedParts].sort((a, b) => a - b),
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    ...(session.documentId ? { documentId: session.documentId } : {}),
    ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function validatePdfMagic(filePath) {
  const handle = await open(filePath, 'r')
  try {
    const prefix = Buffer.alloc(5)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    if (prefix.subarray(0, bytesRead).toString('ascii') !== '%PDF-') {
      throw new HttpError(422, 'invalid_pdf', 'assembled file is not a PDF')
    }
  } finally {
    await handle.close()
  }
}

async function writeRequestStream(request, targetPath, expectedSize) {
  let receivedBytes = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length
      if (receivedBytes > expectedSize) {
        callback(new HttpError(413, 'part_too_large', 'upload part exceeds its expected size'))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(request, limiter, createWriteStream(targetPath, { flags: 'wx' }))
  return receivedBytes
}

async function appendFileToStream(sourcePath, output, hash) {
  for await (const chunk of openReadStream(sourcePath)) {
    hash.update(chunk)
    if (!output.write(chunk)) await once(output, 'drain')
  }
}

export class UploadSessionService {
  constructor({
    storageRoot,
    maxDocumentSize,
    chunkSize,
    documentStorage,
    documentRepository,
    inspectionService,
    now = () => new Date(),
  }) {
    this.uploadRoot = path.join(storageRoot, 'temp', 'uploads')
    this.maxDocumentSize = maxDocumentSize
    this.chunkSize = chunkSize
    this.documentStorage = documentStorage
    this.documentRepository = documentRepository
    this.inspectionService = inspectionService
    this.now = now
    this.locks = new Map()
  }

  async init() {
    await ensureDirectory(this.uploadRoot)
    await this.cleanupExpiredUploadSessions()
  }

  sessionDirectory(uploadId) {
    if (!safeSessionId(uploadId)) {
      throw new HttpError(400, 'invalid_upload_session', 'invalid upload session id')
    }
    return path.join(this.uploadRoot, uploadId)
  }

  sessionFile(uploadId) {
    return path.join(this.sessionDirectory(uploadId), SESSION_FILE)
  }

  partDirectory(uploadId) {
    return path.join(this.sessionDirectory(uploadId), 'parts')
  }

  partPath(uploadId, partNumber) {
    if (!safePartNumber(partNumber)) throw new HttpError(400, 'invalid_part_number', 'invalid part number')
    return path.join(this.partDirectory(uploadId), `${partNumber}.part`)
  }

  async loadSession(uploadId) {
    try {
      return await readJson(this.sessionFile(uploadId))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new HttpError(404, 'upload_session_not_found', 'upload session not found')
      }
      throw error
    }
  }

  async saveSession(session) {
    session.updatedAt = this.now().toISOString()
    await atomicWriteJson(this.sessionFile(session.id), session)
  }

  async discoverReceivedParts(session) {
    const parts = []
    try {
      const entries = await readdir(this.partDirectory(session.id), { withFileTypes: true })
      for (const entry of entries) {
        const match = entry.name.match(/^(\d+)\.part$/)
        if (!entry.isFile() || !match) continue
        const partNumber = Number.parseInt(match[1], 10)
        if (!safePartNumber(partNumber) || partNumber > session.expectedParts) continue
        const partStat = await stat(path.join(this.partDirectory(session.id), entry.name))
        if (partStat.size === expectedPartSize(session, partNumber)) parts.push(partNumber)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return parts.sort((a, b) => a - b)
  }

  async loadFreshSession(uploadId) {
    const session = await this.loadSession(uploadId)
    const discovered = await this.discoverReceivedParts(session)
    if (JSON.stringify(discovered) !== JSON.stringify(session.receivedParts ?? [])) {
      session.receivedParts = discovered
      await this.saveSession(session)
    }
    return session
  }

  assertNotExpired(session) {
    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      session.status = 'expired'
      throw new HttpError(410, 'upload_session_expired', 'upload session has expired')
    }
  }

  async create({ filename, byteSize, mimeType }) {
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new HttpError(400, 'invalid_filename', 'filename is required')
    }
    if (mimeType !== 'application/pdf') {
      throw new HttpError(415, 'invalid_mime_type', 'mimeType must be application/pdf')
    }
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new HttpError(400, 'invalid_byte_size', 'byteSize must be a positive integer')
    }
    if (byteSize > this.maxDocumentSize) {
      throw new HttpError(413, 'document_too_large', `document exceeds ${this.maxDocumentSize} bytes`)
    }

    const now = this.now()
    const id = randomUUID()
    const session = {
      id,
      originalFilename: displayFilename(filename),
      declaredByteSize: byteSize,
      chunkSize: this.chunkSize,
      expectedParts: Math.ceil(byteSize / this.chunkSize),
      receivedParts: [],
      status: 'created',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
    }
    await ensureDirectory(this.partDirectory(id))
    await this.saveSession(session)
    return publicSession(session)
  }

  async get(uploadId) {
    const session = await this.loadFreshSession(uploadId)
    return publicSession(session)
  }

  async receivePart(uploadId, partNumber, request, contentLength) {
    return this.withLock(uploadId, async () => {
      const session = await this.loadFreshSession(uploadId)
      this.assertNotExpired(session)
      if (!['created', 'uploading'].includes(session.status)) {
        throw new HttpError(409, 'upload_not_writable', `upload session is ${session.status}`)
      }
      if (!safePartNumber(partNumber) || partNumber > session.expectedParts) {
        throw new HttpError(400, 'invalid_part_number', 'part number is outside the expected range')
      }
      if (session.receivedParts.includes(partNumber)) {
        throw new HttpError(409, 'duplicate_part', 'upload part has already been received')
      }

      const expectedSize = expectedPartSize(session, partNumber)
      if (contentLength !== undefined && contentLength !== expectedSize) {
        throw new HttpError(400, 'part_size_mismatch', `part must contain exactly ${expectedSize} bytes`)
      }

      await ensureDirectory(this.partDirectory(uploadId))
      const temporaryPath = path.join(this.partDirectory(uploadId), `.${partNumber}.${randomUUID()}.part`)
      const finalPath = this.partPath(uploadId, partNumber)
      try {
        const receivedBytes = await writeRequestStream(request, temporaryPath, expectedSize)
        if (receivedBytes !== expectedSize) {
          throw new HttpError(400, 'part_size_mismatch', `part must contain exactly ${expectedSize} bytes`)
        }
        await link(temporaryPath, finalPath)
        await rm(temporaryPath, { force: true })
      } catch (error) {
        await rm(temporaryPath, { force: true })
        if (error?.code === 'EEXIST') {
          throw new HttpError(409, 'duplicate_part', 'upload part has already been received')
        }
        throw error
      }

      session.receivedParts = [...new Set([...session.receivedParts, partNumber])].sort((a, b) => a - b)
      session.status = 'uploading'
      await this.saveSession(session)
      return {
        uploadSessionId: uploadId,
        partNumber,
        byteSize: expectedSize,
        receivedParts: session.receivedParts,
      }
    })
  }

  async assemble(session) {
    const assembledPath = path.join(this.sessionDirectory(session.id), `assembled.${randomUUID()}.pdf`)
    const output = createWriteStream(assembledPath, { flags: 'wx' })
    const hash = createHash('sha256')
    let totalBytes = 0
    try {
      for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
        const partPath = this.partPath(session.id, partNumber)
        const partStat = await stat(partPath)
        const expectedSize = expectedPartSize(session, partNumber)
        if (partStat.size !== expectedSize) {
          throw new HttpError(400, 'part_size_mismatch', `part ${partNumber} has an unexpected size`)
        }
        totalBytes += partStat.size
        await appendFileToStream(partPath, output, hash)
      }
      await new Promise((resolve, reject) => {
        output.once('error', reject)
        output.end(resolve)
      })
      if (totalBytes !== session.declaredByteSize) {
        throw new HttpError(400, 'assembled_size_mismatch', 'assembled PDF size does not match declaration')
      }
      await validatePdfMagic(assembledPath)
      return {
        assembledPath,
        byteSize: totalBytes,
        sha256: hash.digest('hex'),
      }
    } catch (error) {
      output.destroy()
      await rm(assembledPath, { force: true })
      throw error
    }
  }

  async complete(uploadId) {
    return this.withLock(uploadId, async () => {
      const session = await this.loadFreshSession(uploadId)
      this.assertNotExpired(session)
      if (session.status === 'completed' && session.documentId) {
        return { uploadSession: publicSession(session), document: await this.documentRepository.getById(session.documentId) }
      }
      if (!['created', 'uploading'].includes(session.status)) {
        throw new HttpError(409, 'upload_not_completable', `upload session is ${session.status}`)
      }

      const missingParts = []
      for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
        if (!(await fileExists(this.partPath(uploadId, partNumber)))) missingParts.push(partNumber)
      }
      if (missingParts.length > 0) {
        session.status = 'uploading'
        await this.saveSession(session)
        throw new HttpError(409, 'missing_parts', 'upload is missing one or more parts', { missingParts })
      }

      session.status = 'assembling'
      await this.saveSession(session)
      let assembled
      try {
        assembled = await this.assemble(session)
        const documentId = randomUUID()
        const asset = await this.documentStorage.storeOriginalPdf({
          documentId,
          byteSize: assembled.byteSize,
          sha256: assembled.sha256,
          content: openReadStream(assembled.assembledPath),
        })
        const now = this.now().toISOString()
        let document = {
          id: documentId,
          title: session.originalFilename,
          originalAssetId: asset.id,
          pageCount: 0,
          processingStatus: 'uploaded',
          createdAt: now,
          updatedAt: now,
        }
        await this.documentRepository.saveBundle({ document, asset, pages: [], inspectionSummary: null })

        session.status = 'completed'
        session.documentId = documentId
        await this.saveSession(session)
        await rm(this.partDirectory(uploadId), { recursive: true, force: true })

        document = {
          ...document,
          processingStatus: 'inspecting',
          updatedAt: this.now().toISOString(),
        }
        await this.documentRepository.saveBundle({ document, asset, pages: [], inspectionSummary: null })

        try {
          const report = await this.inspectionService.inspect(this.documentStorage.resolveAbsolutePath(asset))
          const pageCount = report.pageCount ?? report.pages?.length ?? 0
          if (!Number.isInteger(pageCount) || pageCount <= 0) {
            throw new Error('inspection did not return a usable page count')
          }
          const pages = Array.from({ length: pageCount }, (_, index) => ({
            id: `${documentId}-page-${index + 1}`,
            documentId,
            pdfPage: index + 1,
          }))
          const inspectionSummary = {
            pageCount,
            pagesWithText: report.textLayer?.pagesWithText ?? null,
            pagesWithoutText: report.textLayer?.pagesWithoutText ?? null,
            scannedPageRatio: report.textLayer?.scannedPageRatio ?? null,
            warningCount: Array.isArray(report.warnings) ? report.warnings.length : 0,
            inspectedAt: report.inspectedAt ?? this.now().toISOString(),
          }
          document = {
            ...document,
            pageCount,
            processingStatus: 'ready',
            updatedAt: this.now().toISOString(),
            inspectionSummary,
          }
          await this.documentRepository.saveBundle({ document, asset, pages, inspectionSummary })
          return { uploadSession: publicSession(session), document, asset, inspectionSummary }
        } catch (error) {
          document = { ...document, processingStatus: 'failed', updatedAt: this.now().toISOString() }
          await this.documentRepository.saveBundle({ document, asset, pages: [], inspectionSummary: null })
          session.errorMessage = error instanceof Error ? error.message : String(error)
          await this.saveSession(session)
          return { uploadSession: publicSession(session), document, asset, inspectionError: session.errorMessage }
        }
      } catch (error) {
        session.status = 'failed'
        session.errorMessage = error instanceof Error ? error.message : String(error)
        await this.saveSession(session)
        throw error
      } finally {
        if (assembled?.assembledPath) await rm(assembled.assembledPath, { force: true })
      }
    })
  }

  async cleanupExpiredUploadSessions(now = this.now()) {
    await ensureDirectory(this.uploadRoot)
    const entries = await readdir(this.uploadRoot, { withFileTypes: true })
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeSessionId(entry.name)) continue
      try {
        const session = await readJson(path.join(this.uploadRoot, entry.name, SESSION_FILE))
        if (session.status !== 'completed' && new Date(session.expiresAt).getTime() <= now.getTime()) {
          await removeDirectory(path.join(this.uploadRoot, entry.name))
          removed += 1
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return removed
  }

  async withLock(uploadId, operation) {
    const previous = this.locks.get(uploadId) ?? Promise.resolve()
    let release
    const current = new Promise((resolve) => {
      release = resolve
    })
    const chain = previous.then(() => current)
    this.locks.set(uploadId, chain)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(uploadId) === chain) this.locks.delete(uploadId)
    }
  }
}
