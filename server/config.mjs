import path from 'node:path'

export const projectRoot = path.resolve(import.meta.dirname, '..')
export const DEFAULT_MAX_DOCUMENT_SIZE = 1024 * 1024 * 1024
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024
export const DEFAULT_INSPECTION_TIMEOUT_MS = 5 * 60 * 1000
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_AI_REVIEW_MAX_CHAPTER_CHARS = 500_000
export const DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10
export const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
export const DEFAULT_LOGIN_RATE_LIMIT_MAX_IDENTITIES = 10_000

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
  const envAiReviewMaxChapterChars = positiveInteger(
    process.env.AI_REVIEW_MAX_CHAPTER_CHARS,
    DEFAULT_AI_REVIEW_MAX_CHAPTER_CHARS,
  )
  const envLoginRateLimitMaxAttempts = positiveInteger(
    process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  )
  const envLoginRateLimitWindowMs = positiveInteger(
    process.env.LOGIN_RATE_LIMIT_WINDOW_MS,
    DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS,
  )
  const envLoginRateLimitMaxIdentities = positiveInteger(
    process.env.LOGIN_RATE_LIMIT_MAX_IDENTITIES,
    DEFAULT_LOGIN_RATE_LIMIT_MAX_IDENTITIES,
  )

  const authRequired = overrides.authRequired ?? process.env.WORKBENCH_AUTH_REQUIRED === '1'
  const accessUsername = overrides.accessUsername ?? process.env.WORKBENCH_ACCESS_USERNAME
  const accessPassword = overrides.accessPassword ?? process.env.WORKBENCH_ACCESS_PASSWORD

  if (authRequired && (typeof accessUsername !== 'string' || accessUsername.trim().length === 0)) {
    throw new Error('WORKBENCH_ACCESS_USERNAME is required when workbench authentication is enabled')
  }
  if (authRequired && (typeof accessPassword !== 'string' || accessPassword.trim().length === 0)) {
    throw new Error('WORKBENCH_ACCESS_PASSWORD is required when workbench authentication is enabled')
  }

  return {
    host: overrides.host ?? process.env.DOCUMENT_API_HOST ?? '127.0.0.1',
    port: overrides.port ?? envPort,
    storageRoot: path.resolve(
      overrides.storageRoot ?? process.env.DOCUMENT_STORAGE_ROOT ?? path.join(projectRoot, 'storage'),
    ),
    maxDocumentSize: overrides.maxDocumentSize ?? envMaxSize,
    chunkSize: overrides.chunkSize ?? envChunkSize,
    inspectionTimeoutMs: overrides.inspectionTimeoutMs ?? envTimeout,
    authRequired,
    accessUsername,
    accessPassword,
    sessionTtlMs: overrides.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    aiReviewMaxChapterChars: overrides.aiReviewMaxChapterChars ?? envAiReviewMaxChapterChars,
    loginRateLimitMaxAttempts: overrides.loginRateLimitMaxAttempts ?? envLoginRateLimitMaxAttempts,
    loginRateLimitWindowMs: overrides.loginRateLimitWindowMs ?? envLoginRateLimitWindowMs,
    loginRateLimitMaxIdentities: overrides.loginRateLimitMaxIdentities ?? envLoginRateLimitMaxIdentities,
  }
}
