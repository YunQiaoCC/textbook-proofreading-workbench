import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServerConfig } from './config.mjs'
import { FileBackedDocumentRepository } from './repositories/fileBackedDocumentRepository.mjs'
import { FileBackedProofreadingRepository } from './repositories/fileBackedProofreadingRepository.mjs'
import { FileBackedTextRepository } from './repositories/fileBackedTextRepository.mjs'
import { LocalDocumentStorage } from './services/localDocumentStorage.mjs'
import { PopplerInspectionService } from './services/popplerInspection.mjs'
import { DocumentReadService } from './services/documentReadService.mjs'
import { ChapterService } from './services/chapterService.mjs'
import { MAX_PROOFREADING_BODY_BYTES, ProofreadingService } from './services/proofreadingService.mjs'
import { HttpError, UploadSessionService } from './services/uploadSessionService.mjs'
import { DocumentLifecycleCoordinator } from './services/documentLifecycleCoordinator.mjs'
import { DocumentDeletionService } from './services/documentDeletionService.mjs'
import { NativePdfTextExtractor } from './services/nativePdfTextExtractor.mjs'
import { DocumentTextService } from './services/documentTextService.mjs'
import { PdfPageVisualTriage } from './services/pdfPageVisualTriage.mjs'

const MAX_JSON_BODY = 64 * 1024

function sendJson(response, statusCode, value, headers = {}) {
  const body = JSON.stringify(value)
  response.statusCode = statusCode
  for (const [name, headerValue] of Object.entries(headers)) {
    response.setHeader(name, headerValue)
  }
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

async function readJsonBody(request, maxBytes = MAX_JSON_BODY) {
  const chunks = []
  let totalBytes = 0
  for await (const chunk of request) {
    totalBytes += chunk.length
    if (totalBytes > maxBytes) {
      throw new HttpError(413, 'json_body_too_large', 'JSON request body is too large')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON')
  }
}

function routeSegments(requestUrl) {
  let parsed
  try {
    parsed = new URL(requestUrl, 'http://127.0.0.1')
  } catch {
    throw new HttpError(400, 'invalid_url', 'invalid request URL')
  }
  try {
    return parsed.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
  } catch {
    throw new HttpError(400, 'invalid_url', 'invalid URL encoding')
  }
}

function requestContentLength(request) {
  if (!request.headers['content-length']) return undefined
  const value = Number(request.headers['content-length'])
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function errorResponse(error) {
  if (error instanceof HttpError) {
    const body = {
      error: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    }
    if (error.code === 'proofreading_revision_conflict') {
      body.currentRevision = error.details?.currentRevision
    }
    return {
      statusCode: error.statusCode,
      body,
      headers: error.headers,
    }
  }
  if (error?.code === 'document_not_found') {
    return { statusCode: 404, body: { error: error.code, message: 'document not found' } }
  }
  if (error?.code === 'document_not_ready') {
    return { statusCode: 409, body: { error: error.code, message: error.message } }
  }
  if (error?.code === 'invalid_pdf_page') {
    return { statusCode: 400, body: { error: error.code, message: error.message } }
  }
  console.error(error)
  return {
    statusCode: 500,
    body: { error: 'internal_error', message: 'internal server error' },
  }
}

async function handleRequest(request, response, uploadService, documentReadService, chapterService, proofreadingService, documentDeletionService, documentTextService) {
  const segments = routeSegments(request.url ?? '/')

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'documents') {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    sendJson(response, 200, await documentReadService.list())
    return
  }

  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'documents') {
    if (request.method === 'GET') {
      sendJson(response, 200, await documentReadService.detail(segments[2]))
      return
    }
    if (request.method === 'DELETE') {
      await documentDeletionService.delete(segments[2])
      response.statusCode = 204
      response.end()
      return
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'text' &&
    segments[4] === 'extract'
  ) {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    sendJson(response, 202, await documentTextService.start(segments[2]))
    return
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'text' &&
    ['status', 'summary'].includes(segments[4])
  ) {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    sendJson(response, 200, await documentTextService.status(segments[2]))
    return
  }

  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'pages' &&
    segments[5] === 'text'
  ) {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    const artifact = await documentTextService.page(segments[2], Number(segments[4]))
    if (!artifact) throw new HttpError(404, 'page_text_not_found', 'page text has not been extracted')
    sendJson(response, 200, artifact)
    return
  }

  // Legacy/document-scope compatibility layer. New UI writes chapter scope.
  if (
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'pages'
  ) {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    sendJson(response, 200, await documentReadService.pages(segments[2]))
    return
  }

  if (
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'chapters'
  ) {
    if (request.method === 'GET') {
      sendJson(response, 200, await chapterService.list(segments[2]))
      return
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      sendJson(response, 201, await chapterService.create(segments[2], body))
      return
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'chapters'
  ) {
    if (request.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    const body = await readJsonBody(request)
    sendJson(response, 200, await chapterService.update(segments[2], segments[4], body))
    return
  }

  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'chapters' &&
    segments[5] === 'proofreading'
  ) {
    if (request.method === 'GET') {
      sendJson(response, 200, await proofreadingService.getChapter(segments[2], segments[4]))
      return
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request, MAX_PROOFREADING_BODY_BYTES)
      sendJson(response, 200, await proofreadingService.saveChapter(segments[2], segments[4], body))
      return
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  if (
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'proofreading'
  ) {
    if (request.method === 'GET') {
      sendJson(response, 200, await proofreadingService.get(segments[2]))
      return
    }
    if (request.method === 'PUT') {
      const body = await readJsonBody(request, MAX_PROOFREADING_BODY_BYTES)
      sendJson(response, 200, await proofreadingService.save(segments[2], body))
      return
    }
    throw new HttpError(405, 'method_not_allowed', 'method not allowed')
  }

  if (
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'documents' &&
    segments[3] === 'file'
  ) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    }
    await documentReadService.serveFile(segments[2], request, response)
    return
  }

  if (request.method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'uploads') {
    const body = await readJsonBody(request)
    sendJson(response, 201, await uploadService.create(body))
    return
  }

  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'uploads') {
    const uploadId = segments[2]
    if (request.method === 'GET') {
      sendJson(response, 200, await uploadService.get(uploadId))
      return
    }
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'uploads' &&
    segments[3] === 'parts' &&
    request.method === 'PUT'
  ) {
    const uploadId = segments[2]
    const partNumber = Number(segments[4])
    sendJson(
      response,
      201,
      await uploadService.receivePart(uploadId, partNumber, request, requestContentLength(request)),
    )
    return
  }

  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'uploads' && segments[3] === 'complete') {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed')
    sendJson(response, 200, await uploadService.complete(segments[2]))
    return
  }

  throw new HttpError(404, 'not_found', 'route not found')
}

export async function createIngestionServer(options = {}) {
  const config = createServerConfig(options)
  const lifecycleCoordinator = new DocumentLifecycleCoordinator()
  const documentStorage = new LocalDocumentStorage(config.storageRoot)
  const documentRepository = new FileBackedDocumentRepository(config.storageRoot, { lifecycleCoordinator })
  const proofreadingRepository = new FileBackedProofreadingRepository(config.storageRoot, {
    lifecycleCoordinator,
    documentExists: async (documentId) => Boolean(await documentRepository.getById(documentId)),
  })
  const textRepository = new FileBackedTextRepository(config.storageRoot)
  const documentReadService = new DocumentReadService({ documentRepository, documentStorage })
  const chapterService = new ChapterService({ documentRepository })
  const proofreadingService = new ProofreadingService({ documentRepository, proofreadingRepository })
  const nativeTextExtractor = options.nativeTextExtractor ?? new NativePdfTextExtractor({
    pdftotextBin: options.pdftotextBin,
    timeoutMs: options.textExtractionPageTimeoutMs,
  })
  const pageVisualTriage = options.pageVisualTriage ?? new PdfPageVisualTriage({
    pdftoppmBin: options.pdftoppmBin,
  })
  const documentTextService = new DocumentTextService({
    documentRepository,
    documentStorage,
    textRepository,
    extractor: nativeTextExtractor,
    visualTriage: pageVisualTriage,
    lifecycleCoordinator,
  })
  const documentDeletionService = new DocumentDeletionService({
    documentRepository,
    proofreadingRepository,
    textRepository,
    documentStorage,
    lifecycleCoordinator,
  })
  const inspectionService = new PopplerInspectionService({
    storageRoot: config.storageRoot,
    timeoutMs: config.inspectionTimeoutMs,
  })
  await documentStorage.init()
  await documentRepository.init()
  await proofreadingRepository.init()
  await inspectionService.init()
  await documentTextService.init()
  const uploadService = new UploadSessionService({
    storageRoot: config.storageRoot,
    maxDocumentSize: config.maxDocumentSize,
    chunkSize: config.chunkSize,
    documentStorage,
    documentRepository,
    inspectionService,
    onDocumentReady: (document) => documentTextService.start(document.id),
  })
  await uploadService.init()

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, uploadService, documentReadService, chapterService, proofreadingService, documentDeletionService, documentTextService).catch((error) => {
      if (!response.headersSent) {
        const result = errorResponse(error)
        sendJson(response, result.statusCode, result.body, result.headers)
      } else {
        response.destroy()
      }
      if (request.method === 'PUT') request.resume()
    })
  })

  const cleanupTimer = setInterval(() => {
    void uploadService.cleanupExpiredUploadSessions().catch((error) => console.error(error))
  }, 15 * 60 * 1000)
  cleanupTimer.unref()

  return {
    server,
    config,
    documentStorage,
    documentRepository,
    documentReadService,
    chapterService,
    proofreadingRepository,
    proofreadingService,
    textRepository,
    documentTextService,
    nativeTextExtractor,
    pageVisualTriage,
    uploadService,
    documentDeletionService,
    lifecycleCoordinator,
    async close() {
      clearInterval(cleanupTimer)
      if (!server.listening) return
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

async function main() {
  const app = await createIngestionServer()
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`document ingestion API listening on http://${app.config.host}:${app.config.port}`)
    console.log(`private storage root: ${app.config.storageRoot}`)
  })
  const shutdown = async () => {
    await app.close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
