export const DEEPSEEK_PROVIDER = 'deepseek'
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEFAULT_DEEPSEEK_TIMEOUT_MS = 120_000

const ERROR_CODES = new Set([
  'deepseek_unconfigured',
  'deepseek_timeout',
  'deepseek_rate_limited',
  'deepseek_auth_error',
  'deepseek_bad_response',
  'deepseek_output_incomplete',
  'deepseek_output_invalid',
  'deepseek_provider_error',
])
const UPSTREAM_ERROR_CATEGORIES = new Set([
  'invalid_json_schema',
  'invalid_parameter',
  'context_too_long',
  'authentication',
  'rate_limit',
  'unknown_bad_request',
])
const SAFE_UPSTREAM_CODE = /^[A-Za-z0-9_.-]{1,80}$/u

function cleanBaseUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('DeepSeek base URL must be credential-free HTTPS')
  }
  return url.toString().replace(/\/$/u, '')
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export class DeepSeekProviderError extends Error {
  constructor(code, { status, usage, durationMs, upstreamErrorCategory, upstreamErrorCode } = {}) {
    super(code)
    this.name = 'DeepSeekProviderError'
    this.code = ERROR_CODES.has(code) ? code : 'deepseek_provider_error'
    this.status = status
    this.usage = usage
    this.durationMs = durationMs
    this.upstreamErrorCategory = UPSTREAM_ERROR_CATEGORIES.has(upstreamErrorCategory)
      ? upstreamErrorCategory
      : undefined
    this.upstreamErrorCode = SAFE_UPSTREAM_CODE.test(upstreamErrorCode ?? '')
      ? upstreamErrorCode
      : undefined
  }
}

class DeepSeekConfig {
  #apiKey

  constructor({ apiKey, baseUrl, model, timeoutMs }) {
    this.#apiKey = apiKey
    this.provider = DEEPSEEK_PROVIDER
    this.configured = Boolean(apiKey)
    this.baseUrl = baseUrl
    this.model = model
    this.timeoutMs = timeoutMs
    Object.freeze(this)
  }

  getApiKey() { return this.#apiKey }

  toJSON() {
    return { configured: this.configured, provider: this.provider, model: this.model }
  }
}

export function createDeepSeekConfig(overrides = {}) {
  const env = overrides.env ?? process.env
  const rawKey = overrides.apiKey ?? env.DEEPSEEK_API_KEY
  const apiKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : undefined
  const rawModel = overrides.model ?? env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL
  const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : DEFAULT_DEEPSEEK_MODEL
  return new DeepSeekConfig({
    apiKey,
    baseUrl: cleanBaseUrl(overrides.baseUrl ?? env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL),
    model,
    timeoutMs: positiveInteger(overrides.timeoutMs ?? env.DEEPSEEK_TIMEOUT_MS, DEFAULT_DEEPSEEK_TIMEOUT_MS),
  })
}

export function getDeepSeekStatus(config = createDeepSeekConfig()) {
  return config.toJSON()
}

function usageFrom(response) {
  const usage = response?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const inputDetails = usage.input_tokens_details ?? {}
  const outputDetails = usage.output_tokens_details ?? {}
  return {
    input_tokens: Number(usage.input_tokens) || 0,
    cached_tokens: Number(inputDetails.cached_tokens) || 0,
    output_tokens: Number(usage.output_tokens) || 0,
    reasoning_tokens: Number(outputDetails.reasoning_tokens) || 0,
    total_tokens: Number(usage.total_tokens) || 0,
  }
}

function outputText(response) {
  for (const item of response?.output ?? []) {
    if (item?.type !== 'message') continue
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  return typeof response?.output_text === 'string' ? response.output_text : null
}

function statusError(status) {
  if (status === 401 || status === 403) return 'deepseek_auth_error'
  if (status === 429) return 'deepseek_rate_limited'
  if (status >= 500) return 'deepseek_provider_error'
  return 'deepseek_bad_response'
}

function categoryFrom(status, machineValues, message) {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate_limit'
  const diagnostic = [...machineValues, message].filter((value) => typeof value === 'string').join(' ').toLowerCase()
  if (/(json.?schema|response.?format|schema.?validation)/u.test(diagnostic)) return 'invalid_json_schema'
  if (/(context.?length|context.?too.?long|maximum.?context)/u.test(diagnostic)) return 'context_too_long'
  if (/(auth|api.?key|permission)/u.test(diagnostic)) return 'authentication'
  if (/(rate.?limit|too.?many.?requests)/u.test(diagnostic)) return 'rate_limit'
  if (/(invalid.?parameter|invalid.?argument|invalid.?request)/u.test(diagnostic)) return 'invalid_parameter'
  return 'unknown_bad_request'
}

async function sanitizedUpstreamError(response) {
  let payload
  try { payload = await response.json() } catch { payload = null }
  const error = payload?.error && typeof payload.error === 'object' ? payload.error : {}
  const machineValues = [error.code, error.type].filter((value) => typeof value === 'string')
  const upstreamErrorCode = machineValues.find((value) => SAFE_UPSTREAM_CODE.test(value))
  return {
    upstreamErrorCategory: categoryFrom(response.status, machineValues, typeof error.message === 'string' ? error.message : ''),
    ...(upstreamErrorCode ? { upstreamErrorCode } : {}),
  }
}

export class DeepSeekResponsesClient {
  constructor(options = {}) {
    this.config = options.config ?? createDeepSeekConfig(options)
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
  }

  getStatus() { return getDeepSeekStatus(this.config) }

  async requestStructured({ instructions, input, schema, schemaName, reasoningEffort, maxOutputTokens }) {
    if (!this.config.configured) throw new DeepSeekProviderError('deepseek_unconfigured')
    const startedAt = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    let response
    try {
      response = await this.fetch(`${this.config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.getApiKey()}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          instructions,
          input,
          reasoning: { effort: reasoningEffort },
          max_output_tokens: maxOutputTokens,
          text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
        }),
      })
    } catch (error) {
      const code = controller.signal.aborted || error?.name === 'AbortError' ? 'deepseek_timeout' : 'deepseek_provider_error'
      throw new DeepSeekProviderError(code, { durationMs: this.now() - startedAt })
    } finally {
      clearTimeout(timer)
    }

    const durationMs = this.now() - startedAt
    if (!response.ok) {
      const diagnostic = await sanitizedUpstreamError(response)
      throw new DeepSeekProviderError(statusError(response.status), {
        status: response.status,
        durationMs,
        ...diagnostic,
      })
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw new DeepSeekProviderError('deepseek_bad_response', { status: response.status, durationMs })
    }
    const usage = usageFrom(payload)
    if (payload.status === 'incomplete') {
      throw new DeepSeekProviderError('deepseek_output_incomplete', { status: response.status, usage, durationMs })
    }
    if (payload.status === 'failed') {
      throw new DeepSeekProviderError('deepseek_provider_error', { status: response.status, usage, durationMs })
    }
    if (payload.status !== 'completed') {
      throw new DeepSeekProviderError('deepseek_bad_response', { status: response.status, usage, durationMs })
    }
    const text = outputText(payload)
    if (!text) throw new DeepSeekProviderError('deepseek_output_invalid', { status: response.status, usage, durationMs })
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new DeepSeekProviderError('deepseek_output_invalid', { status: response.status, usage, durationMs })
    }
    return { data, usage, durationMs }
  }
}
