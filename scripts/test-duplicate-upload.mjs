#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { FileBackedAiReviewRepository } from '../server/repositories/fileBackedAiReviewRepository.mjs'
import { FileBackedDocumentRepository } from '../server/repositories/fileBackedDocumentRepository.mjs'
import { FileBackedProofreadingRepository } from '../server/repositories/fileBackedProofreadingRepository.mjs'
import { AiChapterReviewService, createEmptyAiReviewWorkspace } from '../server/services/aiChapterReviewService.mjs'
import { ChapterService } from '../server/services/chapterService.mjs'
import { DocumentLifecycleCoordinator } from '../server/services/documentLifecycleCoordinator.mjs'
import { LocalDocumentStorage } from '../server/services/localDocumentStorage.mjs'
import { ProofreadingService } from '../server/services/proofreadingService.mjs'
import { UploadSessionService } from '../server/services/uploadSessionService.mjs'

function makePdf(label) {
  return Buffer.from(`%PDF-1.4\n% synthetic ${label}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function createUploadedSession(uploadService, filename, bytes) {
  const session = await uploadService.create({
    filename,
    byteSize: bytes.length,
    mimeType: 'application/pdf',
  })
  for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
    const start = (partNumber - 1) * session.chunkSize
    const part = bytes.subarray(start, Math.min(bytes.length, start + session.chunkSize))
    await uploadService.receivePart(session.id, partNumber, Readable.from(part), part.length)
  }
  return session
}

async function upload(uploadService, filename, bytes) {
  const session = await createUploadedSession(uploadService, filename, bytes)
  return uploadService.complete(session.id)
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'duplicate-upload-'))
  const lifecycleCoordinator = new DocumentLifecycleCoordinator()
  const documentStorage = new LocalDocumentStorage(root)
  const documentRepository = new FileBackedDocumentRepository(root, { lifecycleCoordinator })
  const proofreadingRepository = new FileBackedProofreadingRepository(root, {
    lifecycleCoordinator,
    documentExists: async (documentId) => Boolean(await documentRepository.getById(documentId)),
  })
  const aiReviewRepository = new FileBackedAiReviewRepository(root, {
    lifecycleCoordinator,
    documentExists: async (documentId) => Boolean(await documentRepository.getById(documentId)),
  })
  const readyDocumentIds = []
  const uploadService = new UploadSessionService({
    storageRoot: root,
    maxDocumentSize: 1024 * 1024,
    chunkSize: 8,
    documentStorage,
    documentRepository,
    inspectionService: {
      inspect: async () => ({
        pageCount: 1,
        pages: [{}],
        textLayer: { pagesWithText: 1, pagesWithoutText: 0, scannedPageRatio: 0 },
        warnings: [],
        inspectedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    onDocumentReady: (document) => readyDocumentIds.push(document.id),
  })
  const chapterService = new ChapterService({ documentRepository })
  const proofreadingService = new ProofreadingService({ documentRepository, proofreadingRepository })
  const aiReviewService = new AiChapterReviewService({ documentRepository, aiReviewRepository })

  await documentStorage.init()
  await documentRepository.init()
  await proofreadingRepository.init()
  await aiReviewRepository.init()
  await uploadService.init()

  try {
    const pdfA = makePdf('A')
    const pdfB = makePdf('B-different-content')
    const pdfConcurrent = makePdf('concurrent-C')

    const first = await upload(uploadService, 'textbook-a.pdf', pdfA)
    assert.equal(first.reusedExistingDocument, false)
    assert.equal(first.inspectionError, undefined)
    assert.equal(first.document.pageCount, 1)
    assert.equal((await documentRepository.listDocuments()).length, 1)

    const sameFilenameDuplicate = await upload(uploadService, 'textbook-a.pdf', pdfA)
    assert.equal(sameFilenameDuplicate.reusedExistingDocument, true)
    assert.equal(sameFilenameDuplicate.document.id, first.document.id)
    assert.equal((await documentRepository.listDocuments()).length, 1)

    const differentContent = await upload(uploadService, 'textbook-a.pdf', pdfB)
    assert.equal(differentContent.reusedExistingDocument, false)
    assert.notEqual(differentContent.document.id, first.document.id)
    assert.equal((await documentRepository.listDocuments()).length, 2)

    const chapter = await chapterService.create(first.document.id, {
      title: 'Synthetic Chapter',
      order: 1,
      startPdfPage: 1,
      endPdfPage: 1,
      assigneeName: 'Reviewer',
      status: 'in_progress',
    })
    await proofreadingService.saveChapter(first.document.id, chapter.id, {
      baseRevision: 0,
      annotations: [],
      issues: [],
    })
    await aiReviewRepository.save(
      first.document.id,
      chapter.id,
      createEmptyAiReviewWorkspace(first.document.id, chapter.id),
      0,
    )

    const firstHash = sha256(pdfA)
    const beforeMatch = await documentRepository.findByAssetSha256(firstHash)
    const beforeState = {
      document: structuredClone(await documentRepository.getById(first.document.id)),
      asset: structuredClone(beforeMatch.asset),
      chapters: structuredClone(await documentRepository.listChapters(first.document.id)),
      proofreading: structuredClone(await proofreadingRepository.getChapter(first.document.id, chapter.id)),
      aiReview: structuredClone(await aiReviewService.get(first.document.id, chapter.id)),
    }

    const differentFilenameDuplicateSession = await createUploadedSession(uploadService, 'renamed-copy.pdf', pdfA)
    const differentFilenameDuplicate = await uploadService.complete(differentFilenameDuplicateSession.id)
    assert.equal(differentFilenameDuplicate.reusedExistingDocument, true)
    assert.equal(differentFilenameDuplicate.document.id, first.document.id)
    assert.equal((await documentRepository.listDocuments()).length, 2)

    const idempotentDuplicate = await uploadService.complete(differentFilenameDuplicateSession.id)
    assert.equal(idempotentDuplicate.reusedExistingDocument, true)
    assert.equal(idempotentDuplicate.document.id, first.document.id)
    assert.equal((await documentRepository.listDocuments()).length, 2)

    const afterMatch = await documentRepository.findByAssetSha256(firstHash)
    const afterState = {
      document: await documentRepository.getById(first.document.id),
      asset: afterMatch.asset,
      chapters: await documentRepository.listChapters(first.document.id),
      proofreading: await proofreadingRepository.getChapter(first.document.id, chapter.id),
      aiReview: await aiReviewService.get(first.document.id, chapter.id),
    }
    assert.deepEqual(afterState, beforeState)
    assert.equal(
      await pathExists(path.join(root, 'temp', 'uploads', differentFilenameDuplicateSession.id, 'parts')),
      false,
    )

    const concurrentBefore = (await documentRepository.listDocuments()).length
    const concurrentSessionA = await createUploadedSession(uploadService, 'concurrent-a.pdf', pdfConcurrent)
    const concurrentSessionB = await createUploadedSession(uploadService, 'concurrent-b.pdf', pdfConcurrent)
    const [concurrentA, concurrentB] = await Promise.all([
      uploadService.complete(concurrentSessionA.id),
      uploadService.complete(concurrentSessionB.id),
    ])
    assert.equal(new Set([concurrentA.document.id, concurrentB.document.id]).size, 1)
    assert.deepEqual(
      [concurrentA.reusedExistingDocument, concurrentB.reusedExistingDocument].sort(),
      [false, true],
    )
    assert.equal((await documentRepository.listDocuments()).length, concurrentBefore + 1)

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(readyDocumentIds.length, 3)
    assert.equal(new Set(readyDocumentIds).size, 3)

    const uploaderSource = await readFile(new URL('../src/components/DocumentUploader.vue', import.meta.url), 'utf8')
    assert.match(uploaderSource, /const duplicateNotice = ref\(''\)/u)
    assert.match(uploaderSource, /检测到该教材已存在，已进入现有教材继续协作，未创建重复副本。/u)
    assert.match(uploaderSource, /class="duplicate-notice" role="status"/u)

    console.log('first-upload-creates-document=pass')
    console.log('exact-duplicate-reuses-existing-document=pass')
    console.log('same-filename-different-content-allowed=pass')
    console.log('same-content-different-filename-reused=pass')
    console.log('duplicate-complete-idempotent=pass')
    console.log('concurrent-exact-duplicate-single-document=pass')
    console.log('existing-document-state-preserved=pass')
    console.log('duplicate-upload-temporary-parts-cleaned=pass')
    console.log('duplicate-uploader-notice=pass')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
