#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'
const documentId = 'chapter-collaboration-document'

function fixtureDocument(id = documentId, pageCount = 20) {
  return {
    id,
    title: 'Chapter collaboration test document',
    originalAssetId: 'original-asset',
    pageCount,
    processingStatus: 'ready',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function chapterBody(title, startPdfPage, endPdfPage, order, assigneeName, status = 'not_started') {
  return { title, startPdfPage, endPdfPage, order, assigneeName, status }
}

function proofreadingPayload(suffix, baseRevision, pdfPage) {
  const annotationId = `annotation-${suffix}`
  return {
    baseRevision,
    annotations: [{ id: annotationId, kind: 'highlight', payload: { selectedText: suffix } }],
    issues: [{
      id: `issue-${suffix}`,
      annotationId,
      pdfPage,
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

async function jsonRequest(baseUrl, route, method, body) {
  return request(baseUrl, route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-chapters-'))
  let app = await createIngestionServer({ storageRoot: root })
  let baseUrl = await listen(app)

  try {
    await app.documentRepository.saveBundle({ document: fixtureDocument(), asset: null, pages: [] })

    const empty = await request(baseUrl, `/api/documents/${documentId}/chapters`)
    assert.equal(empty.response.status, 200)
    assert.deepEqual(empty.body.chapters, [])

    const createdA = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters`,
      'POST',
      chapterBody('Chapter A', 1, 10, 1, '张三', 'in_progress'),
    )
    const createdB = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters`,
      'POST',
      chapterBody('Chapter B', 11, 20, 2, '李四'),
    )
    assert.equal(createdA.response.status, 201)
    assert.equal(createdB.response.status, 201)
    const chapterA = createdA.body
    const chapterB = createdB.body
    assert.equal(chapterA.startPdfPage, 1)
    assert.equal(chapterA.endPdfPage, 10)
    assert.equal(chapterA.status, 'in_progress')
    assert.equal(chapterA.assigneeName, '张三')

    const listed = await request(baseUrl, `/api/documents/${documentId}/chapters`)
    assert.equal(listed.body.chapters.length, 2)
    assert.deepEqual(listed.body.chapters.map((chapter) => chapter.id), [chapterA.id, chapterB.id])

    const updatedB = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters/${chapterB.id}`,
      'PUT',
      chapterBody('Chapter B updated', 11, 20, 2, '李四', 'completed'),
    )
    assert.equal(updatedB.response.status, 200)
    assert.equal(updatedB.body.status, 'completed')

    const invalidTitle = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters`,
      'POST',
      chapterBody('   ', 1, 2, 3, ''),
    )
    assert.equal(invalidTitle.response.status, 400)
    const invalidRange = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters`,
      'POST',
      chapterBody('Invalid range', 20, 21, 3, ''),
    )
    assert.equal(invalidRange.response.status, 400)
    const invalidStatus = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters`,
      'POST',
      chapterBody('Invalid status', 1, 2, 3, '', 'reviewing'),
    )
    assert.equal(invalidStatus.response.status, 400)
    const traversal = await request(
      baseUrl,
      `/api/documents/${documentId}/chapters/%2e%2e%2fetc`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    assert.equal(traversal.response.status, 404)

    const emptyA = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`)
    const emptyB = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterB.id}/proofreading`)
    assert.equal(emptyA.response.status, 200)
    assert.equal(emptyA.body.chapterId, chapterA.id)
    assert.equal(emptyA.body.revision, 0)
    assert.equal(emptyB.body.chapterId, chapterB.id)
    assert.equal(emptyB.body.revision, 0)

    const [a1, b1] = await Promise.all([
      jsonRequest(
        baseUrl,
        `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
        'PUT',
        proofreadingPayload('a1', 0, 5),
      ),
      jsonRequest(
        baseUrl,
        `/api/documents/${documentId}/chapters/${chapterB.id}/proofreading`,
        'PUT',
        proofreadingPayload('b1', 0, 15),
      ),
    ])
    assert.equal(a1.response.status, 200)
    assert.equal(a1.body.revision, 1)
    assert.equal(b1.response.status, 200)
    assert.equal(b1.body.revision, 1)

    const a2 = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
      'PUT',
      proofreadingPayload('a2', 1, 6),
    )
    assert.equal(a2.response.status, 200)
    assert.equal(a2.body.revision, 2)
    const bStillOne = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterB.id}/proofreading`)
    assert.equal(bStillOne.body.revision, 1)
    assert.equal(bStillOne.body.issues[0].pdfPage, 15)

    const aConcurrent = await Promise.all([
      jsonRequest(
        baseUrl,
        `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
        'PUT',
        proofreadingPayload('a3-left', 2, 7),
      ),
      jsonRequest(
        baseUrl,
        `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
        'PUT',
        proofreadingPayload('a3-right', 2, 8),
      ),
    ])
    assert.equal(aConcurrent.filter(({ response }) => response.status === 200).length, 1)
    assert.equal(aConcurrent.filter(({ response }) => response.status === 409).length, 1)
    assert.equal(aConcurrent.find(({ response }) => response.status === 409).body.currentRevision, 3)

    const aCurrent = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`)
    const inRange = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
      'PUT',
      proofreadingPayload('a-in-range', aCurrent.body.revision, 5),
    )
    assert.equal(inRange.response.status, 200)
    const afterInRange = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`)
    const outsideRange = await jsonRequest(
      baseUrl,
      `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`,
      'PUT',
      proofreadingPayload('a-outside', afterInRange.body.revision, 11),
    )
    assert.equal(outsideRange.response.status, 400)
    assert.equal(outsideRange.body.error, 'issue_outside_chapter_range')

    const chapterRecordPath = path.join(root, 'metadata', 'proofreading', documentId, `${chapterA.id}.json`)
    assert.equal((await stat(chapterRecordPath)).isFile(), true)

    await app.close()
    app = await createIngestionServer({ storageRoot: root })
    baseUrl = await listen(app)
    const restartedChapters = await request(baseUrl, `/api/documents/${documentId}/chapters`)
    assert.equal(restartedChapters.body.chapters.length, 2)
    const restartedA = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterA.id}/proofreading`)
    const restartedB = await request(baseUrl, `/api/documents/${documentId}/chapters/${chapterB.id}/proofreading`)
    assert.equal(restartedA.body.revision, afterInRange.body.revision)
    assert.equal(restartedB.body.revision, 1)

    const migrationDocumentId = 'legacy-migration-document'
    await app.documentRepository.saveBundle({ document: fixtureDocument(migrationDocumentId, 40), asset: null, pages: [] })
    const migrationChapterA = await app.chapterService.create(
      migrationDocumentId,
      chapterBody('Migration A', 1, 10, 1, 'A'),
    )
    const migrationChapterB = await app.chapterService.create(
      migrationDocumentId,
      chapterBody('Migration B', 11, 20, 2, 'B'),
    )
    const legacy = {
      baseRevision: 0,
      annotations: [
        { id: 'annotation-migrate-a', kind: 'highlight', payload: { selectedText: 'a' } },
        { id: 'annotation-migrate-b', kind: 'highlight', payload: { selectedText: 'b' } },
        { id: 'annotation-migrate-skip', kind: 'highlight', payload: { selectedText: 'skip' } },
      ],
      issues: [
        proofreadingPayload('migrate-a', 0, 5).issues[0],
        proofreadingPayload('migrate-b', 0, 15).issues[0],
        { ...proofreadingPayload('migrate-skip', 0, 30).issues[0], annotationId: 'annotation-migrate-skip' },
      ],
    }
    const legacySave = await app.proofreadingService.save(migrationDocumentId, legacy)
    assert.equal(legacySave.revision, 1)
    const migration = await app.proofreadingService.migrateLegacyToChapters(migrationDocumentId)
    assert.equal(migration.status, 'migrated_with_skips')
    assert.deepEqual(migration.migratedIssueIds.sort(), ['issue-migrate-a', 'issue-migrate-b'])
    assert.equal(migration.skipped[0].reason, 'no_matching_chapter')
    assert.equal((await app.proofreadingService.getChapter(migrationDocumentId, migrationChapterA.id)).issues[0].pdfPage, 5)
    assert.equal((await app.proofreadingService.getChapter(migrationDocumentId, migrationChapterB.id)).issues[0].pdfPage, 15)
    assert.equal((await app.proofreadingService.get(migrationDocumentId)).revision, 1)
    const blockedMigration = await app.proofreadingService.migrateLegacyToChapters(migrationDocumentId)
    assert.equal(blockedMigration.status, 'blocked')

    console.log('chapter-list-create-update=pass')
    console.log('chapter-validation-and-traversal=pass')
    console.log('per-chapter-empty-workspaces=pass')
    console.log('different-chapters-concurrent-revision-independent=pass')
    console.log('same-chapter-revision-conflict=pass')
    console.log('chapter-range-validation=pass')
    console.log('chapter-storage-restart-recovery=pass')
    console.log('legacy-migration-helper-with-skips=pass')
    console.log('legacy-workspace-preserved-and-migration-blocked-after-copy=pass')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
