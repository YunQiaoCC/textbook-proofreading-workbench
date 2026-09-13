import { requestJson } from './apiClient'

export interface AuthAccount {
  username: string
}

export interface AuthSessionResponse {
  authenticated: boolean
  account: AuthAccount | null
}

export function getSession() {
  return requestJson<AuthSessionResponse>('/auth/session')
}

export function login(username: string, password: string) {
  return requestJson<AuthSessionResponse>('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

export function logout() {
  return requestJson<void>('/auth/logout', { method: 'POST' })
}
