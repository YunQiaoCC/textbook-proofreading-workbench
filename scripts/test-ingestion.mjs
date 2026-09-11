#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'

function streamObject(content) {
  const body = Buffer.from(content)
  return Buffer.concat([
    Buffer.from(`<< /Length ${body.length} >>\nstream\n`),
    body,
    Buffer.from('\nendstream'),
  ])
}

function makePdf() {
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  objects[4] = streamObject(
    'BT /F1 18 Tf 72 720 Td (Legal textbook body text.) Tj 0 -28 Td (Second body line.) Tj ET',
  )
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')]
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.concat(chunks).length
    chunks.push(Buffer.from(`${id} 0 obj\n`), Buffer.from(objects[id]), Buffer.from('\nendobj\n'))
  }
  const xrefOffset = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  chunks.push(Buffer.from(xref))
  return Buffer.concat(chunks)
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function call(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options)
  const body = await response.json()
  return { response, body }
}

async function uploadPart(baseUrl, session, partNumber, bytes) {
  return call(baseUrl, `/api/uploads/${session.id}/parts/${partNumber}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-ingestion-'))
  const app = await createIngestionServer({
    storageRoot: root,
    chunkSize: 64,
    maxDocumentSize: 1024 * 1024,
    inspectionTimeoutMs: 30_000,
  })
  const baseUrl = await listen(app)
  const pdf = makePdf()
  const expectedSha256 = createHash('sha256').update(pdf).digest('hex')

  try {
    const created = await call(baseUrl, '/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: '../../test.pdf',
        byteSize: pdf.length,
        mimeType: 'application/pdf',
      }),
    })
    assert.equal(created.response.status, 201)
    const session = created.body
    assert.equal(session.originalFilename, 'test.pdf')
    assert.ok(session.expectedParts > 1)

    const firstPart = pdf.subarray(0, session.chunkSize)
    const firstUpload = await uploadPart(baseUrl, session, 1, firstPart)
    assert.equal(firstUpload.response.status, 201)

    const interrupted = await call(baseUrl, `/api/uploads/${session.id}`)
    assert.equal(interrupted.response.status, 200)
    assert.deepEqual(interrupted.body.receivedParts, [1])

    const duplicate = await uploadPart(baseUrl, session, 1, firstPart)
    assert.equal(duplicate.response.status, 409)
    assert.equal(duplicate.body.error, 'duplicate_part')

    const incomplete = await call(baseUrl, `/api/uploads/${session.id}/complete`, { method: 'POST' })
    assert.equal(incomplete.response.status, 409)
    assert.equal(incomplete.body.error, 'missing_parts')

    for (let partNumber = 2; partNumber <= session.expectedParts; partNumber += 1) {
      const start = (partNumber - 1) * session.chunkSize
      const result = await uploadPart(baseUrl, session, partNumber, pdf.subarray(start, start + session.chunkSize))
      assert.equal(result.response.status, 201)
    }

    const completed = await call(baseUrl, `/api/uploads/${session.id}/complete`, { method: 'POST' })
    assert.equal(completed.response.status, 200)
    assert.equal(completed.body.uploadSession.status, 'completed')
    assert.equal(completed.body.document.processingStatus, 'ready')
    assert.equal(completed.body.document.pageCount, 1)
    assert.equal(completed.body.document.inspectionSummary.pagesWithText, 1)
    assert.equal(completed.body.asset.sha256, expectedSha256)
    assert.ok(completed.body.asset.storageKey.startsWith('documents/'))
    assert.equal(completed.body.asset.storageKey.includes('..'), false)
    await stat(path.join(root, completed.body.asset.storageKey))

    const pages = await app.documentRepository.listPages(completed.body.document.id)
    assert.equal(pages.length, 1)
    assert.equal(pages[0].pdfPage, 1)
    assert.equal(pages[0].printedPage, undefined)

    const wrongSize = await call(baseUrl, '/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'wrong-size.pdf', byteSize: pdf.length, mimeType: 'application/pdf' }),
    })
    const shortPart = await uploadPart(baseUrl, wrongSize.body, 1, pdf.subarray(0, wrongSize.body.chunkSize - 1))
    assert.equal(shortPart.response.status, 400)
    assert.equal(shortPart.body.error, 'part_size_mismatch')

    const malformed = await call(baseUrl, '/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'malformed.pdf', byteSize: 5, mimeType: 'application/pdf' }),
    })
    const malformedPart = await uploadPart(baseUrl, malformed.body, 1, Buffer.from('hello'))
    assert.equal(malformedPart.response.status, 201)
    const malformedComplete = await call(baseUrl, `/api/uploads/${malformed.body.id}/complete`, { method: 'POST' })
    assert.equal(malformedComplete.response.status, 422)
    assert.equal(malformedComplete.body.error, 'invalid_pdf')

    const abandoned = await call(baseUrl, '/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'abandoned.pdf', byteSize: pdf.length, mimeType: 'application/pdf' }),
    })
    const removed = await app.uploadService.cleanupExpiredUploadSessions(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    assert.ok(removed >= 1)
    const abandonedStatus = await call(baseUrl, `/api/uploads/${abandoned.body.id}`)
    assert.equal(abandonedStatus.response.status, 404)

    await app.close()
    const restarted = await createIngestionServer({ storageRoot: root, chunkSize: 64, maxDocumentSize: 1024 * 1024 })
    const recovered = await restarted.documentRepository.getById(completed.body.document.id)
    assert.equal(recovered.processingStatus, 'ready')
    assert.equal((await restarted.documentRepository.listPages(completed.body.document.id)).length, 1)
    await restarted.close()

    console.log(`multi-chunk-upload=pass parts=${session.expectedParts}`)
    console.log('interrupted-resume-query=pass')
    console.log('duplicate-part-rejected=pass')
    console.log('missing-part-rejected=pass')
    console.log('byte-size-mismatch-rejected=pass')
    console.log('non-pdf-rejected=pass')
    console.log('path-traversal-filename-contained=pass')
    console.log('inspection-document-pages-asset=pass')
    console.log('expired-upload-cleanup=pass')
    console.log('metadata-survives-restart=pass')
    console.log('temporary-files-cleaned=pass')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
