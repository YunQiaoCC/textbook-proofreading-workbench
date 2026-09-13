export const API_BASE_URL = '/api'

let authenticationRequiredHandler: (() => void) | null = null

export function setAuthenticationRequiredHandler(handler: () => void) {
  authenticationRequiredHandler = handler
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function encodePathSegment(value: string) {
  return encodeURIComponent(value)
}

export function apiPath(path: string) {
  return `${API_BASE_URL}${path}`
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiPath(path), { credentials: 'same-origin', ...init })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'network_error', '网络错误，请检查连接')
  }

  let body: unknown = null
  try {
    body = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text()
  } catch {
    body = null
  }

  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const code = typeof record.error === 'string' ? record.error : 'request_failed'
    const message = typeof record.message === 'string' ? record.message : '请求失败，请稍后重试'
    if (response.status === 401 && code === 'authentication_required') {
      authenticationRequiredHandler?.()
    }
    throw new ApiError(response.status, code, message)
  }

  return body as T
}
