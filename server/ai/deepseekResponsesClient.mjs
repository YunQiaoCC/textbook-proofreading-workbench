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
  constructor(code, { status, usage, durationMs } = {}) {
    super(code)
    this.name = 'DeepSeekProviderError'
    this.code = ERROR_CODES.has(code) ? code : 'deepseek_provider_error'
    this.status = status
    this.usage = usage
    this.durationMs = durationMs
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
      throw new DeepSeekProviderError(statusError(response.status), { status: response.status, durationMs })
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
