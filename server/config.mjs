import path from 'node:path'

export const projectRoot = path.resolve(import.meta.dirname, '..')
export const DEFAULT_MAX_DOCUMENT_SIZE = 1024 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024
export const DEFAULT_INSPECTION_TIMEOUT_MS = 5 * 60 * 1000

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function createServerConfig(overrides = {}) {
  const envPort = positiveInteger(process.env.DOCUMENT_API_PORT, 8787)
  const envMaxSize = positiveInteger(process.env.MAX_DOCUMENT_SIZE, DEFAULT_MAX_DOCUMENT_SIZE)
  const envChunkSize = positiveInteger(process.env.UPLOAD_CHUNK_SIZE, DEFAULT_CHUNK_SIZE)
  const envTimeout = positiveInteger(
    process.env.INSPECTION_TIMEOUT_MS,
    DEFAULT_INSPECTION_TIMEOUT_MS,
  )

  return {
    host: overrides.host ?? process.env.DOCUMENT_API_HOST ?? '127.0.0.1',
    port: overrides.port ?? envPort,
    storageRoot: path.resolve(
      overrides.storageRoot ?? process.env.DOCUMENT_STORAGE_ROOT ?? path.join(projectRoot, 'storage'),
    ),
    maxDocumentSize: overrides.maxDocumentSize ?? envMaxSize,
    chunkSize: overrides.chunkSize ?? envChunkSize,
    inspectionTimeoutMs: overrides.inspectionTimeoutMs ?? envTimeout,
  }
}
