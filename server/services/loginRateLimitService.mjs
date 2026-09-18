import { isIP } from 'node:net'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

function normalizeIp(value) {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase()
  if (candidate.startsWith('::ffff:') && isIP(candidate.slice(7)) === 4) {
    return candidate.slice(7)
  }
  return isIP(candidate) ? candidate : null
}

function remoteAddress(request) {
  return normalizeIp(request.socket?.remoteAddress) ?? 'unknown'
}

export function loginRequestIdentity(request) {
  const remote = remoteAddress(request)
  if (LOOPBACK_ADDRESSES.has(remote)) {
    const proxyAddress = normalizeIp(request.headers['x-real-ip'])
    if (proxyAddress) return `ip:${proxyAddress}`
  }
  return `ip:${remote}`
}

export class LoginRateLimitService {
  constructor({ maxAttempts, windowMs, maxIdentities, now = () => Date.now() }) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxIdentities = maxIdentities
    this.now = now
    this.failures = new Map()
  }

  pruneExpired(timestamp = this.now()) {
    for (const [identity, bucket] of this.failures) {
      if (bucket.expiresAt <= timestamp) this.failures.delete(identity)
    }
  }

  evictOldest() {
    let oldestIdentity = null
    let oldestExpiry = Infinity
    for (const [identity, bucket] of this.failures) {
      if (bucket.expiresAt < oldestExpiry) {
        oldestIdentity = identity
        oldestExpiry = bucket.expiresAt
      }
    }
    if (oldestIdentity !== null) this.failures.delete(oldestIdentity)
  }

  recordFailure(identity) {
    const timestamp = this.now()
    this.pruneExpired(timestamp)
    let bucket = this.failures.get(identity)
    if (!bucket) {
      if (this.failures.size >= this.maxIdentities) this.evictOldest()
      bucket = { failures: 0, expiresAt: timestamp + this.windowMs }
      this.failures.set(identity, bucket)
    }
    bucket.failures += 1
    return {
      limited: bucket.failures >= this.maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - timestamp) / 1000)),
    }
  }

  reset(identity) {
    this.failures.delete(identity)
  }

  get size() {
    this.pruneExpired()
    return this.failures.size
  }
}
