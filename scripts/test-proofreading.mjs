#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'

const documentId = 'proofreading-test-document'
const timestamp = '2026-01-01T00:00:00.000Z'

function fixtureDocument() {
  return {
    id: documentId,
    title: 'Proofreading test document',
    originalAssetId: 'original-asset',
    pageCount: 1,
    processingStatus: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function payload(suffix, baseRevision) {
  const annotationId = `annotation-${suffix}`
  return {
    baseRevision,
    annotations: [{ id: annotationId, kind: 'highlight', payload: { selectedText: suffix } }],
    issues: [{
      id: `issue-${suffix}`,
      annotationId,
      pdfPage: 1,
      printedPage: '',
      originalText: `original-${suffix}`,
      category: 'typo',
      suggestion: `suggestion-${suffix}`,
      reason: '',
      status: 'pending',
      reviewer: 'test-reviewer',
      verifier: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }
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
  const body = await response.json()
  return { response, body }
}

async function put(baseUrl, body) {
  return request(baseUrl, `/api/documents/${documentId}/proofreading`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-proofreading-'))
  let app = await createIngestionServer({ storageRoot: root })
  let baseUrl = await listen(app)

  try {
    await app.documentRepository.saveBundle({ document: fixtureDocument(), asset: null, pages: [] })

    const empty = await request(baseUrl, `/api/documents/${documentId}/proofreading`)
    assert.equal(empty.response.status, 200)
    assert.equal(empty.body.revision, 0)
    assert.deepEqual(empty.body.annotations, [])
    assert.deepEqual(empty.body.issues, [])

    const first = await put(baseUrl, payload('first', 0))
    assert.equal(first.response.status, 200)
    assert.equal(first.body.revision, 1)

    const recovered = await request(baseUrl, `/api/documents/${documentId}/proofreading`)
    assert.equal(recovered.response.status, 200)
    assert.equal(recovered.body.revision, 1)
    assert.equal(recovered.body.annotations[0].id, 'annotation-first')
    assert.equal(recovered.body.issues[0].annotationId, 'annotation-first')

    const second = await put(baseUrl, payload('second', 1))
    assert.equal(second.response.status, 200)
    assert.equal(second.body.revision, 2)

    const stale = await put(baseUrl, payload('stale', 1))
    assert.equal(stale.response.status, 409)
    assert.equal(stale.body.error, 'proofreading_revision_conflict')
    assert.equal(stale.body.currentRevision, 2)
    const afterConflict = await request(baseUrl, `/api/documents/${documentId}/proofreading`)
    assert.equal(afterConflict.body.revision, 2)
    assert.equal(afterConflict.body.annotations[0].id, 'annotation-second')

    const invalidCategory = await put(baseUrl, { ...payload('invalid-category', 2), issues: [{ ...payload('invalid-category', 2).issues[0], category: 'not-a-category' }] })
    assert.equal(invalidCategory.response.status, 400)
    assert.equal(invalidCategory.body.error, 'invalid_category')

    const invalidStatus = await put(baseUrl, { ...payload('invalid-status', 2), issues: [{ ...payload('invalid-status', 2).issues[0], status: 'not-a-status' }] })
    assert.equal(invalidStatus.response.status, 400)
    assert.equal(invalidStatus.body.error, 'invalid_status')

    const duplicateIssue = payload('duplicate-issue', 2)
    duplicateIssue.issues.push({ ...duplicateIssue.issues[0], annotationId: 'annotation-other' })
    const duplicateIssueResult = await put(baseUrl, duplicateIssue)
    assert.equal(duplicateIssueResult.response.status, 400)
    assert.equal(duplicateIssueResult.body.error, 'duplicate_issue_id')

    const duplicateAnnotation = payload('duplicate-annotation', 2)
    duplicateAnnotation.annotations.push({ id: duplicateAnnotation.annotations[0].id, kind: 'underline' })
    const duplicateAnnotationResult = await put(baseUrl, duplicateAnnotation)
    assert.equal(duplicateAnnotationResult.response.status, 400)
    assert.equal(duplicateAnnotationResult.body.error, 'duplicate_annotation_id')

    const oversized = JSON.stringify({
      baseRevision: 2,
      annotations: [{ id: 'oversized', payload: 'x'.repeat(8 * 1024 * 1024) }],
      issues: [],
    })
    const oversizedResult = await request(baseUrl, `/api/documents/${documentId}/proofreading`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    })
    assert.equal(oversizedResult.response.status, 413)

    const concurrent = await Promise.all([
      put(baseUrl, payload('concurrent-a', 2)),
      put(baseUrl, payload('concurrent-b', 2)),
    ])
    assert.equal(concurrent.filter(({ response }) => response.status === 200).length, 1)
    assert.equal(concurrent.filter(({ response }) => response.status === 409).length, 1)
    const concurrentConflict = concurrent.find(({ response }) => response.status === 409)
    assert.equal(concurrentConflict.body.currentRevision, 3)

    const unknown = await request(baseUrl, '/api/documents/does-not-exist/proofreading')
    assert.equal(unknown.response.status, 404)

    const traversal = await request(baseUrl, '/api/documents/%2e%2e%2fetc/proofreading')
    assert.equal(traversal.response.status, 404)

    await app.close()
    app = await createIngestionServer({ storageRoot: root })
    baseUrl = await listen(app)
    const restarted = await request(baseUrl, `/api/documents/${documentId}/proofreading`)
    assert.equal(restarted.response.status, 200)
    assert.equal(restarted.body.revision, 3)
    assert.equal(restarted.body.annotations.length, 1)

    console.log('new-document-empty-workspace=pass')
    console.log('put-revision-0=pass')
    console.log('get-persisted-data=pass')
    console.log('second-write-revision-2=pass')
    console.log('stale-revision-conflict=pass')
    console.log('invalid-category-status-rejected=pass')
    console.log('duplicate-issue-id-rejected=pass')
    console.log('duplicate-annotation-id-rejected=pass')
    console.log('oversized-body-rejected=pass')
    console.log('concurrent-same-revision-one-wins=pass')
    console.log('unknown-document-404=pass')
    console.log('path-traversal-contained=pass')
    console.log('workspace-survives-restart=pass')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
