#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'
import { createServerConfig, DEFAULT_SESSION_TTL_MS } from '../server/config.mjs'

const username = 'proofreader'
const password = 'auth-test-secret-value'
const timestamp = '2026-09-13T00:00:00.000Z'
let testCount = 0

async function runTest(name, operation) {
  await operation()
  testCount += 1
  console.log(`${name}=pass`)
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options)
  const text = await response.text()
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { response, body, text }
}

function jsonOptions(method, body, cookie, headers = {}) {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

async function login(baseUrl, submittedUsername = username, submittedPassword = password) {
  const result = await request(baseUrl, '/api/auth/login', jsonOptions('POST', {
    username: submittedUsername,
    password: submittedPassword,
  }))
  const setCookie = result.response.headers.get('set-cookie')
  return {
    ...result,
    setCookie,
    cookie: setCookie?.split(';', 1)[0] ?? null,
  }
}

async function createFixture(app) {
  const documentId = 'auth-test-document'
  const pdf = Buffer.from('%PDF-1.4\n% shared authentication test fixture\n%%EOF\n')
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  const asset = await app.documentStorage.storeOriginalPdf({
    documentId,
    byteSize: pdf.length,
    sha256,
    content: [pdf],
  })
  await app.documentRepository.saveBundle({
    document: {
      id: documentId,
      title: 'Authentication fixture',
      originalAssetId: asset.id,
      pageCount: 1,
      processingStatus: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    asset,
    pages: [{ id: 'auth-test-page', documentId, pdfPage: 1 }],
  })
  const chapter = await app.chapterService.create(documentId, {
    title: 'Authentication chapter',
    order: 1,
    startPdfPage: 1,
    endPdfPage: 1,
    assigneeName: 'Chapter Reviewer',
    status: 'in_progress',
  })
  return { documentId, chapter }
}

async function main() {
  const disabledRoot = await mkdtemp(path.join(tmpdir(), 'textbook-auth-disabled-'))
  const disabledApp = await createIngestionServer({ storageRoot: disabledRoot, authRequired: false })
  const disabledBaseUrl = await listen(disabledApp)
  try {
    await runTest('auth-disabled-preserves-existing-api', async () => {
      const result = await request(disabledBaseUrl, '/api/documents')
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body, { documents: [] })
    })
  } finally {
    await disabledApp.close()
    await rm(disabledRoot, { recursive: true, force: true })
  }

  await runTest('required-missing-username-fails-closed', () => {
    const previous = process.env.WORKBENCH_ACCESS_USERNAME
    delete process.env.WORKBENCH_ACCESS_USERNAME
    try {
      assert.throws(
        () => createServerConfig({ authRequired: true, accessPassword: password }),
        /WORKBENCH_ACCESS_USERNAME/,
      )
    } finally {
      if (previous === undefined) delete process.env.WORKBENCH_ACCESS_USERNAME
      else process.env.WORKBENCH_ACCESS_USERNAME = previous
    }
  })
  await runTest('required-missing-password-fails-closed', () => {
    const previous = process.env.WORKBENCH_ACCESS_PASSWORD
    delete process.env.WORKBENCH_ACCESS_PASSWORD
    try {
      assert.throws(
        () => createServerConfig({ authRequired: true, accessUsername: username }),
        /WORKBENCH_ACCESS_PASSWORD/,
      )
    } finally {
      if (previous === undefined) delete process.env.WORKBENCH_ACCESS_PASSWORD
      else process.env.WORKBENCH_ACCESS_PASSWORD = previous
    }
  })

  const root = await mkdtemp(path.join(tmpdir(), 'textbook-auth-required-'))
  let currentTime = Date.parse(timestamp)
  const app = await createIngestionServer({
    storageRoot: root,
    authRequired: true,
    accessUsername: username,
    accessPassword: password,
    sessionNow: () => currentTime,
  })
  const baseUrl = await listen(app)
  const { documentId, chapter } = await createFixture(app)
  const proofreadingRoute = `/api/documents/${documentId}/chapters/${chapter.id}/proofreading`
  const aiReviewRoute = `/api/documents/${documentId}/chapters/${chapter.id}/ai-review`
  let wrongUsernameResult
  let wrongPasswordResult
  let forgedResult
  let firstLogin
  let firstCookie
  let savedWorkspace

  try {
    await runTest('unauthenticated-documents-rejected', async () => {
      const result = await request(baseUrl, '/api/documents')
      assert.equal(result.response.status, 401)
      assert.deepEqual(result.body, { error: 'authentication_required', message: 'authentication required' })
    })
    await runTest('unauthenticated-pdf-get-rejected', async () => {
      const result = await request(baseUrl, `/api/documents/${documentId}/file`)
      assert.equal(result.response.status, 401)
      assert.equal(result.body.error, 'authentication_required')
    })
    await runTest('unauthenticated-pdf-head-rejected', async () => {
      const result = await request(baseUrl, `/api/documents/${documentId}/file`, { method: 'HEAD' })
      assert.equal(result.response.status, 401)
    })
    await runTest('unauthenticated-proofreading-rejected', async () => {
      const result = await request(baseUrl, proofreadingRoute)
      assert.equal(result.response.status, 401)
      assert.equal(result.body.error, 'authentication_required')
    })
    await runTest('unauthenticated-ai-review-rejected', async () => {
      const result = await request(baseUrl, aiReviewRoute)
      assert.equal(result.response.status, 401)
      assert.equal(result.body.error, 'authentication_required')
    })
    await runTest('session-reports-unauthenticated', async () => {
      const result = await request(baseUrl, '/api/auth/session')
      assert.equal(result.response.status, 200)
      assert.deepEqual(result.body, { authenticated: false, account: null })
    })
    await runTest('wrong-username-rejected', async () => {
      wrongUsernameResult = await login(baseUrl, 'wrong-user-sensitive', password)
      assert.equal(wrongUsernameResult.response.status, 401)
      assert.deepEqual(wrongUsernameResult.body, { error: 'invalid_credentials', message: 'invalid credentials' })
    })
    await runTest('wrong-password-rejected', async () => {
      wrongPasswordResult = await login(baseUrl, username, 'wrong-password-sensitive')
      assert.equal(wrongPasswordResult.response.status, 401)
      assert.deepEqual(wrongPasswordResult.body, { error: 'invalid_credentials', message: 'invalid credentials' })
    })
    await runTest('correct-login-succeeds', async () => {
      firstLogin = await login(baseUrl)
      firstCookie = firstLogin.cookie
      assert.equal(firstLogin.response.status, 200)
      assert.deepEqual(firstLogin.body, { authenticated: true, account: { username } })
    })
    await runTest('login-sets-cookie', () => {
      assert.ok(firstCookie?.startsWith('proofread_session='))
    })
    await runTest('cookie-is-httponly', () => {
      assert.match(firstLogin.setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i)
    })
    await runTest('cookie-is-secure', () => {
      assert.match(firstLogin.setCookie, /(?:^|;\s*)Secure(?:;|$)/i)
    })
    await runTest('cookie-is-samesite-lax', () => {
      assert.match(firstLogin.setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i)
    })
    await runTest('session-token-not-returned-in-body', () => {
      assert.equal('token' in firstLogin.body, false)
      assert.equal('sessionId' in firstLogin.body, false)
      assert.equal(firstLogin.text.includes(firstCookie.split('=', 2)[1]), false)
    })
    await runTest('valid-cookie-can-list-documents', async () => {
      const result = await request(baseUrl, '/api/documents', { headers: { cookie: firstCookie } })
      assert.equal(result.response.status, 200)
      assert.equal(result.body.documents[0].id, documentId)
    })
    await runTest('valid-cookie-can-mutate', async () => {
      const payload = {
        baseRevision: 0,
        annotations: [{ id: 'auth-annotation', kind: 'highlight', payload: { selectedText: 'fixture' } }],
        issues: [{
          id: 'auth-issue', annotationId: 'auth-annotation', pdfPage: 1, printedPage: '',
          originalText: 'fixture', category: 'typo', suggestion: 'fixed', reason: '',
          status: 'pending', reviewer: 'Chapter Reviewer', verifier: '',
          createdAt: timestamp, updatedAt: timestamp,
        }],
      }
      const result = await request(baseUrl, proofreadingRoute, jsonOptions('PUT', payload, firstCookie))
      assert.equal(result.response.status, 200)
      assert.equal(result.body.revision, 1)
      savedWorkspace = result.body
    })
    await runTest('session-reports-authenticated', async () => {
      const result = await request(baseUrl, '/api/auth/session', { headers: { cookie: firstCookie } })
      assert.deepEqual(result.body, { authenticated: true, account: { username } })
    })
    await runTest('logout-succeeds-and-clears-cookie', async () => {
      const result = await request(baseUrl, '/api/auth/logout', { method: 'POST', headers: { cookie: firstCookie } })
      assert.equal(result.response.status, 204)
      assert.match(result.response.headers.get('set-cookie'), /^proofread_session=; Max-Age=0;/)
    })
    await runTest('logged-out-cookie-is-rejected', async () => {
      const result = await request(baseUrl, '/api/documents', { headers: { cookie: firstCookie } })
      assert.equal(result.response.status, 401)
    })
    await runTest('expired-session-is-rejected', async () => {
      const expiring = await login(baseUrl)
      currentTime += DEFAULT_SESSION_TTL_MS + 1
      const result = await request(baseUrl, '/api/documents', { headers: { cookie: expiring.cookie } })
      assert.equal(result.response.status, 401)
    })

    let sessionA
    let sessionB
    await runTest('two-browser-sessions-coexist', async () => {
      sessionA = await login(baseUrl)
      sessionB = await login(baseUrl)
      assert.notEqual(sessionA.cookie, sessionB.cookie)
      const [resultA, resultB] = await Promise.all([
        request(baseUrl, '/api/documents', { headers: { cookie: sessionA.cookie } }),
        request(baseUrl, '/api/documents', { headers: { cookie: sessionB.cookie } }),
      ])
      assert.equal(resultA.response.status, 200)
      assert.equal(resultB.response.status, 200)
    })
    await runTest('logout-a-does-not-affect-b', async () => {
      await request(baseUrl, '/api/auth/logout', { method: 'POST', headers: { cookie: sessionA.cookie } })
      const [resultA, resultB] = await Promise.all([
        request(baseUrl, '/api/documents', { headers: { cookie: sessionA.cookie } }),
        request(baseUrl, '/api/documents', { headers: { cookie: sessionB.cookie } }),
      ])
      assert.equal(resultA.response.status, 401)
      assert.equal(resultB.response.status, 200)
    })
    await runTest('forged-cookie-is-rejected', async () => {
      forgedResult = await request(baseUrl, '/api/documents', {
        headers: { cookie: 'proofread_session=forged-session-sensitive' },
      })
      assert.equal(forgedResult.response.status, 401)
    })
    await runTest('authenticated-user-header-is-not-trusted', async () => {
      const result = await request(baseUrl, '/api/documents', {
        headers: { 'x-authenticated-user': username },
      })
      assert.equal(result.response.status, 401)
    })
    await runTest('credentials-and-sessions-never-enter-errors', () => {
      const errors = [wrongUsernameResult.text, wrongPasswordResult.text, forgedResult.text].join('\n')
      assert.equal(errors.includes('wrong-user-sensitive'), false)
      assert.equal(errors.includes('wrong-password-sensitive'), false)
      assert.equal(errors.includes('forged-session-sensitive'), false)
      assert.equal(errors.includes(password), false)
    })
    await runTest('ai-reviewer-remains-chapter-assignee', async () => {
      const running = await app.aiReviewService.startAiRun(documentId, chapter.id, 0)
      const awaiting = await app.aiReviewService.completeAiRun(documentId, chapter.id, [], running.revision)
      const wrong = await request(baseUrl, `${aiReviewRoute}/human-review/start`, jsonOptions('POST', {
        reviewerName: username,
        baseRevision: awaiting.revision,
      }, sessionB.cookie))
      assert.equal(wrong.response.status, 409)
      assert.equal(wrong.body.error, 'ai_review_reviewer_mismatch')
      const correct = await request(baseUrl, `${aiReviewRoute}/human-review/start`, jsonOptions('POST', {
        reviewerName: chapter.assigneeName,
        baseRevision: awaiting.revision,
      }, sessionB.cookie))
      assert.equal(correct.response.status, 200)
      assert.equal(correct.body.humanReview.reviewerName, chapter.assigneeName)
      assert.notEqual(correct.body.humanReview.reviewerName, username)
    })
    await runTest('auth-does-not-change-proofreading-schema', async () => {
      assert.deepEqual(Object.keys(savedWorkspace).sort(), [
        'annotations', 'chapterId', 'createdAt', 'documentId', 'issues', 'revision', 'schemaVersion', 'updatedAt',
      ])
      assert.equal(savedWorkspace.issues[0].reviewer, chapter.assigneeName)
      assert.equal(JSON.stringify(savedWorkspace).includes(username), false)
      assert.equal('account' in savedWorkspace, false)
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }

  assert.equal(testCount, 30)
  console.log(`auth-test-count=${testCount}`)
}

await main()
