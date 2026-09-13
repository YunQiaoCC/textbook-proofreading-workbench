import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'proofread_session'

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

function constantTimeCredentialsMatch(submittedUsername, submittedPassword, username, password) {
  const usernameMatches = timingSafeEqual(digest(submittedUsername), digest(username))
  const passwordMatches = timingSafeEqual(digest(submittedPassword), digest(password))
  const submittedTypesMatch =
    typeof submittedUsername === 'string' && typeof submittedPassword === 'string'
  return Boolean(
    Number(submittedTypesMatch) & Number(usernameMatches) & Number(passwordMatches),
  )
}

function cookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== 'string') return null
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value || null
  }
  return null
}

function sessionCookie(sessionId, maxAgeSeconds) {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export function clearedSessionCookie() {
  return sessionCookie('', 0)
}

export class AuthSessionService {
  constructor({ required, username, password, ttlMs, now = () => Date.now() }) {
    this.required = required
    this.username = username
    this.password = password
    this.ttlMs = ttlMs
    this.now = now
    this.sessions = new Map()
  }

  publicAccount() {
    return typeof this.username === 'string' && this.username.length > 0
      ? { username: this.username }
      : null
  }

  authenticate(username, password) {
    if (!this.required) return { authenticated: true, account: this.publicAccount() }
    if (!constantTimeCredentialsMatch(username, password, this.username, this.password)) return null
    this.pruneExpiredSessions()

    const sessionId = randomBytes(32).toString('base64url')
    const createdAt = this.now()
    const expiresAt = createdAt + this.ttlMs
    this.sessions.set(sessionId, { sessionId, createdAt, expiresAt })
    return {
      authenticated: true,
      account: this.publicAccount(),
      cookie: sessionCookie(sessionId, Math.floor(this.ttlMs / 1000)),
    }
  }

  pruneExpiredSessions() {
    const now = this.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId)
    }
  }

  session(request) {
    if (!this.required) return { authenticated: true, account: this.publicAccount() }
    const sessionId = cookieValue(request.headers.cookie, SESSION_COOKIE_NAME)
    if (!sessionId) return { authenticated: false, account: null }
    const session = this.sessions.get(sessionId)
    if (!session) return { authenticated: false, account: null }
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return { authenticated: false, account: null }
    }
    return { authenticated: true, account: this.publicAccount() }
  }

  logout(request) {
    const sessionId = cookieValue(request.headers.cookie, SESSION_COOKIE_NAME)
    if (sessionId) this.sessions.delete(sessionId)
  }
}
