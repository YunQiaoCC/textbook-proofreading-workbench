import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServerConfig } from './config.mjs'
import { FileBackedDocumentRepository } from './repositories/fileBackedDocumentRepository.mjs'
import { LocalDocumentStorage } from './services/localDocumentStorage.mjs'
import { PopplerInspectionService } from './services/popplerInspection.mjs'
import { HttpError, UploadSessionService } from './services/uploadSessionService.mjs'

const MAX_JSON_BODY = 64 * 1024

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

async function readJsonBody(request) {
  const chunks = []
  let totalBytes = 0
  for await (const chunk of request) {
    totalBytes += chunk.length
    if (totalBytes > MAX_JSON_BODY) {
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
    return {
      statusCode: error.statusCode,
      body: {
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    }
  }
  console.error(error)
  return {
    statusCode: 500,
    body: { error: 'internal_error', message: 'internal server error' },
  }
}

async function handleRequest(request, response, uploadService) {
  const segments = routeSegments(request.url ?? '/')

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
  const documentStorage = new LocalDocumentStorage(config.storageRoot)
  const documentRepository = new FileBackedDocumentRepository(config.storageRoot)
  const inspectionService = new PopplerInspectionService({
    storageRoot: config.storageRoot,
    timeoutMs: config.inspectionTimeoutMs,
  })
  await documentStorage.init()
  await documentRepository.init()
  await inspectionService.init()
  const uploadService = new UploadSessionService({
    storageRoot: config.storageRoot,
    maxDocumentSize: config.maxDocumentSize,
    chunkSize: config.chunkSize,
    documentStorage,
    documentRepository,
    inspectionService,
  })
  await uploadService.init()

  const server = createHttpServer((request, response) => {
    void handleRequest(request, response, uploadService).catch((error) => {
      if (!response.headersSent) {
        const result = errorResponse(error)
        sendJson(response, result.statusCode, result.body)
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
    uploadService,
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
