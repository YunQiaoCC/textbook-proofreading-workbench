#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { createIngestionServer } from '../server/app.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'

function issue(id, annotationId) {
  return {
    id,
    annotationId,
    pdfPage: 2,
    printedPage: '',
    originalText: id,
    category: 'typo',
    suggestion: '',
    reason: '',
    status: 'pending',
    reviewer: 'test',
    verifier: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function annotation(id) {
  return { id, kind: 'highlight', payload: { selectedText: id } }
}

async function loadDeleteHelper() {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('../src/features/proofreading/issueDeletion.ts', import.meta.url),
    'utf8',
  ))
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import('data:text/javascript,' + encodeURIComponent(output))
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return 'http://127.0.0.1:' + app.server.address().port
}

async function request(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, options)
  const text = await response.text()
  return { response, body: text ? JSON.parse(text) : null }
}

function payload(baseRevision, annotations, issues) {
  return { baseRevision, annotations, issues }
}

async function main() {
  const { deleteIssueSnapshot } = await loadDeleteHelper()

  const manual = deleteIssueSnapshot(
    [issue('manual', 'manual-internal')],
    [annotation('other')],
    'manual',
    'manual',
  )
  assert.equal(manual.issues.length, 0)
  assert.deepEqual(manual.annotations.map((item) => item.id), ['other'])
  assert.equal(manual.linkedAnnotationId, null)

  const linked = deleteIssueSnapshot(
    [issue('issue-a', 'annotation-a'), issue('issue-b', 'annotation-b')],
    [annotation('annotation-a'), annotation('annotation-b')],
    'issue-a',
    'issue-a',
  )
  assert.deepEqual(linked.issues.map((item) => item.id), ['issue-b'])
  assert.deepEqual(linked.annotations.map((item) => item.id), ['annotation-b'])
  assert.equal(linked.linkedAnnotationId, 'annotation-a')
  assert.equal(linked.selectedIssueId, 'issue-b')

  const previous = deleteIssueSnapshot(
    [issue('issue-a', 'annotation-a'), issue('issue-b', 'annotation-b')],
    [annotation('annotation-a'), annotation('annotation-b')],
    'issue-b',
    'issue-b',
  )
  assert.equal(previous.selectedIssueId, 'issue-a')

  const last = deleteIssueSnapshot(
    [issue('only', 'annotation-only')],
    [annotation('annotation-only')],
    'only',
    'only',
  )
  assert.equal(last.selectedIssueId, null)
  assert.equal(last.issues.length, 0)
  assert.equal(last.annotations.length, 0)

  const root = await mkdtemp(path.join(tmpdir(), 'textbook-issue-delete-'))
  const app = await createIngestionServer({ storageRoot: root })
  const baseUrl = await listen(app)
  try {
    const document = {
      id: 'issue-delete-document',
      title: 'Issue delete document',
      originalAssetId: 'none',
      pageCount: 20,
      processingStatus: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await app.documentRepository.saveBundle({ document, asset: null, pages: [] })
    const chapterResponse = await request(baseUrl, '/api/documents/' + document.id + '/chapters', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Issue delete chapter', order: 1, startPdfPage: 1, endPdfPage: 20, status: 'not_started' }),
    })
    assert.equal(chapterResponse.response.status, 201)
    const route = '/api/documents/' + document.id + '/chapters/' + chapterResponse.body.id + '/proofreading'
    const initialAnnotations = [annotation('annotation-a'), annotation('annotation-b')]
    const initialIssues = [issue('issue-a', 'annotation-a'), issue('issue-b', 'annotation-b')]
    const initial = await request(baseUrl, route, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(0, initialAnnotations, initialIssues)),
    })
    assert.equal(initial.response.status, 200)

    const afterDelete = deleteIssueSnapshot(initialIssues, initialAnnotations, 'issue-a', 'issue-a')
    const saved = await request(baseUrl, route, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(initial.body.revision, afterDelete.annotations, afterDelete.issues)),
    })
    assert.equal(saved.response.status, 200)
    const refreshed = await request(baseUrl, route)
    assert.deepEqual(refreshed.body.issues.map((item) => item.id), ['issue-b'])
    assert.deepEqual(refreshed.body.annotations.map((item) => item.id), ['annotation-b'])

    const stale = await request(baseUrl, route, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(initial.body.revision, initialAnnotations, initialIssues)),
    })
    assert.equal(stale.response.status, 409)
    assert.equal(stale.body.error, 'proofreading_revision_conflict')
    console.log('manual and linked issue deletion, selection migration, persistence, and stale revision checks passed')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
