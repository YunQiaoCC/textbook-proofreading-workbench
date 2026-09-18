#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'
import {
  LoginRateLimitService,
  loginRequestIdentity,
} from '../server/services/loginRateLimitService.mjs'

const username = 'proofreader'
const password = 'synthetic-rate-limit-password'
let testCount = 0

async function test(name, operation) {
  await operation()
  testCount += 1
  console.log(`${name}=pass`)
}

async function request(baseUrl, usernameValue, passwordValue, ip) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ username: usernameValue, password: passwordValue }),
  })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) }
}

const root = await mkdtemp(path.join(tmpdir(), 'textbook-login-rate-limit-'))
let currentTime = Date.parse('2026-09-18T00:00:00.000Z')
const app = await createIngestionServer({
  storageRoot: root,
  authRequired: true,
  accessUsername: username,
  accessPassword: password,
  loginRateLimitMaxAttempts: 3,
  loginRateLimitWindowMs: 1_000,
  loginRateLimitMaxIdentities: 2,
  loginRateLimitNow: () => currentTime,
})

await new Promise((resolve, reject) => {
  app.server.once('error', reject)
  app.server.listen(0, '127.0.0.1', resolve)
})
const baseUrl = `http://127.0.0.1:${app.server.address().port}`

try {
  let limited
  await test('login-rate-limit-enforces-explicit-threshold', async () => {
    const first = await request(baseUrl, username, 'wrong-one', '198.51.100.10')
    const second = await request(baseUrl, 'unknown-user', 'wrong-two', '198.51.100.10')
    limited = await request(baseUrl, username, 'wrong-three', '198.51.100.10')
    assert.equal(first.response.status, 401)
    assert.equal(second.response.status, 401)
    assert.equal(limited.response.status, 429)
    assert.deepEqual(limited.body, {
      error: 'login_rate_limited',
      message: 'too many login attempts',
    })
    assert.equal(limited.response.headers.get('retry-after'), '1')
  })

  await test('login-rate-limit-does-not-reveal-credential-fields', () => {
    assert.equal(limited.text.includes(username), false)
    assert.equal(limited.text.includes(password), false)
    assert.equal(limited.text.includes('username'), false)
    assert.equal(limited.text.includes('password'), false)
  })

  let successful
  await test('login-rate-limit-is-per-client-ip', async () => {
    successful = await request(baseUrl, username, password, '198.51.100.11')
    assert.equal(successful.response.status, 200)
    const cookie = successful.response.headers.get('set-cookie').split(';', 1)[0]
    const authenticated = await fetch(`${baseUrl}/api/documents`, { headers: { cookie } })
    assert.equal(authenticated.status, 200)
  })

  await test('successful-login-resets-client-bucket', async () => {
    const reset = await request(baseUrl, username, password, '198.51.100.10')
    assert.equal(reset.response.status, 200)
    const nextFailure = await request(baseUrl, username, 'wrong-after-reset', '198.51.100.10')
    assert.equal(nextFailure.response.status, 401)
  })

  await test('login-rate-limit-expires-automatically', async () => {
    currentTime += 1_001
    const afterExpiry = await request(baseUrl, username, 'wrong-after-expiry', '198.51.100.10')
    assert.equal(afterExpiry.response.status, 401)
  })

  await test('login-rate-limit-memory-is-bounded', () => {
    const limiter = new LoginRateLimitService({
      maxAttempts: 3,
      windowMs: 60_000,
      maxIdentities: 2,
      now: () => currentTime,
    })
    limiter.recordFailure('ip:192.0.2.1')
    limiter.recordFailure('ip:192.0.2.2')
    limiter.recordFailure('ip:192.0.2.3')
    assert.equal(limiter.size, 2)
  })

  await test('untrusted-direct-client-cannot-spoof-proxy-ip', () => {
    assert.equal(loginRequestIdentity({
      socket: { remoteAddress: '203.0.113.8' },
      headers: { 'x-real-ip': '198.51.100.20' },
    }), 'ip:203.0.113.8')
  })

  await test('invalid-proxy-ip-falls-back-to-loopback', () => {
    assert.equal(loginRequestIdentity({
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      headers: { 'x-real-ip': 'not-an-ip' },
    }), 'ip:127.0.0.1')
  })
} finally {
  await app.close()
  await rm(root, { recursive: true, force: true })
}

assert.equal(testCount, 8)
console.log(`login-rate-limit-test-count=${testCount}`)
