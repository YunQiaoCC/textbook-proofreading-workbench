import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import {
  RetrievalProviderError,
  normalizeProviderError,
  providerToolResultError,
} from '../errors.mjs'
import { RETRIEVAL_PROVIDER } from '../types.mjs'
import { assertAllowedYuandianTool } from './tool-contracts.mjs'

export const DEFAULT_YUANDIAN_LAW_MCP_URL = 'https://open.chineselaw.com/mcp/law/stream'
export const DEFAULT_YUANDIAN_TIMEOUT_MS = 20_000
export const MAX_YUANDIAN_TIMEOUT_MS = 30_000

function timeoutValue(value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1_000) return DEFAULT_YUANDIAN_TIMEOUT_MS
  return Math.min(parsed, MAX_YUANDIAN_TIMEOUT_MS)
}

function safeEndpoint(value) {
  const endpoint = new URL(value)
  const localHttp = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !localHttp) throw new TypeError('Yuandian MCP endpoint must use HTTPS')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Yuandian MCP endpoint must not contain credentials, query, or fragment')
  }
  return endpoint.toString()
}

class YuandianConfig {
  #apiKey

  constructor({ apiKey, endpoint, timeoutMs }) {
    this.#apiKey = apiKey
    this.provider = RETRIEVAL_PROVIDER
    this.configured = Boolean(apiKey)
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    Object.freeze(this)
  }

  getApiKey() {
    return this.#apiKey
  }

  toJSON() {
    return {
      provider: this.provider,
      configured: this.configured,
      endpoint: this.endpoint,
      timeoutMs: this.timeoutMs,
    }
  }
}

export function createYuandianConfig(overrides = {}) {
  const env = overrides.env ?? process.env
  const rawKey = overrides.apiKey ?? env.YUANDIAN_API_KEY
  const apiKey = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : undefined
  const endpoint = safeEndpoint(
    overrides.endpoint ?? env.YUANDIAN_LAW_MCP_URL ?? DEFAULT_YUANDIAN_LAW_MCP_URL,
  )
  const timeoutMs = timeoutValue(overrides.timeoutMs ?? env.YUANDIAN_MCP_TIMEOUT_MS)
  return new YuandianConfig({ apiKey, endpoint, timeoutMs })
}

export function getYuandianStatus(config = createYuandianConfig()) {
  return {
    provider: RETRIEVAL_PROVIDER,
    configured: config.configured,
    available: config.configured,
    reason: config.configured ? 'configured' : 'missing_api_key',
    remoteChecked: false,
  }
}

async function createSdkSession({ endpoint, apiKey, timeoutMs, signal }) {
  const client = new Client({ name: 'textbook-proofreading-workbench', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: { token: async () => apiKey },
    requestInit: { headers: { accept: 'application/json, text/event-stream' } },
    onInsufficientScope: 'throw',
  })
  try {
    await client.connect(transport, { timeout: timeoutMs, signal })
    return client
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

async function withTimeout(timeoutMs, operation) {
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RetrievalProviderError('timeout'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export class YuandianMcpClient {
  constructor(options = {}) {
    this.config = options.config ?? createYuandianConfig(options)
    this.sessionFactory = options.sessionFactory ?? createSdkSession
    this.sessionPromise = null
  }

  getStatus() {
    return getYuandianStatus(this.config)
  }

  async #session() {
    if (!this.config.configured) throw new RetrievalProviderError('missing_api_key')
    if (!this.sessionPromise) {
      this.sessionPromise = withTimeout(this.config.timeoutMs, (signal) => this.sessionFactory({
        endpoint: this.config.endpoint,
        apiKey: this.config.getApiKey(),
        timeoutMs: this.config.timeoutMs,
        signal,
      })).catch((error) => {
        this.sessionPromise = null
        throw normalizeProviderError(error)
      })
    }
    return this.sessionPromise
  }

  async listTools() {
    try {
      const session = await this.#session()
      return await withTimeout(this.config.timeoutMs, (signal) => session.listTools(
        undefined,
        { timeout: this.config.timeoutMs, signal },
      ))
    } catch (error) {
      throw normalizeProviderError(error)
    }
  }

  async callTool(toolName, args = {}) {
    assertAllowedYuandianTool(toolName)
    try {
      const session = await this.#session()
      const result = await withTimeout(this.config.timeoutMs, (signal) => session.callTool(
        { name: toolName, arguments: args },
        { timeout: this.config.timeoutMs, signal },
      ))
      if (result?.isError) throw providerToolResultError(result)
      return result
    } catch (error) {
      throw normalizeProviderError(error)
    }
  }

  async close() {
    const pending = this.sessionPromise
    this.sessionPromise = null
    if (!pending) return
    try {
      const session = await pending
      await session.close()
    } catch {
      // Connection failures are already normalized at the call boundary.
    }
  }
}
