export const RETRIEVAL_ERROR_CODES = Object.freeze([
  'auth_error',
  'rate_limited',
  'invalid_request',
  'not_found',
  'provider_error',
  'timeout',
  'transport_error',
  'missing_api_key',
])

const ERROR_DEFINITIONS = Object.freeze({
  auth_error: ['Yuandian Law authentication failed', false],
  rate_limited: ['Yuandian Law rate limit exceeded', true],
  invalid_request: ['Yuandian Law rejected the request', false],
  not_found: ['Yuandian Law did not return a matching record', false],
  provider_error: ['Yuandian Law provider failed', true],
  timeout: ['Yuandian Law request timed out', true],
  transport_error: ['Yuandian Law transport failed', true],
  missing_api_key: ['Yuandian Law retrieval is not configured', false],
})

const SAFE_PROVIDER_CODES = new Set([
  'tool_not_allowed',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT',
  'REQUEST_TIMEOUT', 'SEND_FAILED', 'CONNECTION_CLOSED', 'CLIENT_HTTP_FAILED_TO_OPEN_STREAM',
])

function safeProviderCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return SAFE_PROVIDER_CODES.has(trimmed) ? trimmed : undefined
}

export class RetrievalProviderError extends Error {
  constructor(code, options = {}) {
    const definition = ERROR_DEFINITIONS[code] ?? ERROR_DEFINITIONS.provider_error
    // Do not retain the raw provider error as `cause`: SDK/HTTP error metadata
    // may contain request headers or response bodies. The controlled code is
    // the complete observable error contract.
    super(definition[0])
    this.name = 'RetrievalProviderError'
    this.code = ERROR_DEFINITIONS[code] ? code : 'provider_error'
    this.retryable = options.retryable ?? definition[1]
    const providerCode = safeProviderCode(options.providerCode)
    if (providerCode !== undefined) this.providerCode = providerCode
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.providerCode ? { providerCode: this.providerCode } : {}),
    }
  }
}

export function normalizeProviderError(error) {
  if (error instanceof RetrievalProviderError) return error

  const status = Number(error?.status ?? error?.data?.status ?? error?.response?.status)
  const rawCode = safeProviderCode(error?.code ?? error?.data?.code)
  const codeText = String(error?.code ?? '').toLowerCase()
  const nameText = String(error?.name ?? '').toLowerCase()

  if (
    [401, 403].includes(status) ||
    ['auth_error', 'unauthorized', 'forbidden'].includes(codeText) ||
    nameText.includes('unauthorized') ||
    nameText.includes('insufficientscope')
  ) {
    return new RetrievalProviderError('auth_error', { providerCode: status || rawCode, cause: error })
  }
  if (status === 429 || codeText === 'rate_limited') {
    return new RetrievalProviderError('rate_limited', { providerCode: status || rawCode, cause: error })
  }
  if ([400, 422].includes(status) || codeText === 'invalid_request') {
    return new RetrievalProviderError('invalid_request', { providerCode: status || rawCode, cause: error })
  }
  if (status === 404 || codeText === 'not_found') {
    return new RetrievalProviderError('not_found', { providerCode: status || rawCode, cause: error })
  }
  if (
    nameText === 'aborterror' ||
    codeText.includes('timeout') ||
    ['etimedout', 'requesttimeout'].includes(codeText)
  ) {
    return new RetrievalProviderError('timeout', { providerCode: rawCode, cause: error })
  }
  if ([
    'econnrefused', 'econnreset', 'enotfound', 'eai_again', 'epipe',
    'send_failed', 'connection_closed', 'client_http_failed_to_open_stream',
  ].includes(codeText)) {
    return new RetrievalProviderError('transport_error', { providerCode: rawCode, cause: error })
  }
  if (status >= 500) return new RetrievalProviderError('provider_error', { providerCode: status, cause: error })
  return new RetrievalProviderError('provider_error', { providerCode: rawCode, cause: error })
}

export function providerToolResultError(result) {
  const metadata = result?.structuredContent
  const status = metadata && typeof metadata === 'object'
    ? Number(metadata.status ?? metadata.statusCode)
    : undefined
  const code = metadata && typeof metadata === 'object' ? metadata.code : undefined
  return normalizeProviderError({ status, code })
}
