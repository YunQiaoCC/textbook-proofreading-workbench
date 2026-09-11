#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
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
    'BT /F1 18 Tf 72 720 Td (Range delivery smoke test.) Tj 0 -28 Td (Second body line.) Tj ET',
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

  // Keep the fixture large enough for PDF.js to have an opportunity to use
  // its network range reader while preserving the valid xref above.
  chunks.push(Buffer.from(`% ${'range-test-padding '.repeat(8192)}\n`))
  return Buffer.concat(chunks)
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options)
  const body = await response.json()
  return { response, body }
}

async function bytesRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options)
  return { response, bytes: Buffer.from(await response.arrayBuffer()) }
}

async function uploadPdf(baseUrl, pdf, chunkSize) {
  const created = await jsonRequest(baseUrl, '/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'range-smoke.pdf', byteSize: pdf.length, mimeType: 'application/pdf' }),
  })
  assert.equal(created.response.status, 201)
  const session = created.body
  for (let partNumber = 1; partNumber <= session.expectedParts; partNumber += 1) {
    const start = (partNumber - 1) * chunkSize
    const result = await jsonRequest(baseUrl, `/api/uploads/${session.id}/parts/${partNumber}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: pdf.subarray(start, start + chunkSize),
    })
    assert.equal(result.response.status, 201)
  }
  const completed = await jsonRequest(baseUrl, `/api/uploads/${session.id}/complete`, { method: 'POST' })
  assert.equal(completed.response.status, 200)
  assert.equal(completed.body.document.processingStatus, 'ready')
  return completed.body.document.id
}

async function runPdfJsSmokeTest(baseUrl, documentId, expectedPageCount) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    url: `${baseUrl}/api/documents/${documentId}/file`,
    disableWorker: true,
    rangeChunkSize: 1024,
  })
  const pdf = await loadingTask.promise
  try {
    assert.equal(pdf.numPages, expectedPageCount)
  } finally {
    await pdf.destroy()
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-document-read-'))
  const chunkSize = 4096
  const app = await createIngestionServer({
    storageRoot: root,
    chunkSize,
    maxDocumentSize: 2 * 1024 * 1024,
    inspectionTimeoutMs: 30_000,
  })
  const baseUrl = await listen(app)
  const pdf = makePdf()
  const expectedSha256 = createHash('sha256').update(pdf).digest('hex')
  assert.ok(pdf.length > 128)
  let documentId

  try {
    documentId = await uploadPdf(baseUrl, pdf, chunkSize)
    const fileRoute = `/api/documents/${documentId}/file`

    const list = await jsonRequest(baseUrl, '/api/documents')
    assert.equal(list.response.status, 200)
    assert.equal(list.body.documents.length, 1)
    assert.equal(list.body.documents[0].id, documentId)
    assert.equal(list.body.documents[0].pageCount, 1)
    assert.equal('storageKey' in list.body.documents[0], false)
    assert.equal(JSON.stringify(list.body).includes(root), false)

    const detail = await jsonRequest(baseUrl, `/api/documents/${documentId}`)
    assert.equal(detail.response.status, 200)
    assert.equal(detail.body.document.id, documentId)
    assert.equal(detail.body.asset.sha256, expectedSha256)
    assert.equal(detail.body.asset.kind, 'original-pdf')
    assert.equal('storageKey' in detail.body.asset, false)
    assert.equal(JSON.stringify(detail.body).includes(root), false)

    const pages = await jsonRequest(baseUrl, `/api/documents/${documentId}/pages`)
    assert.equal(pages.response.status, 200)
    assert.equal(pages.body.pages.length, 1)
    assert.equal(pages.body.pages[0].pdfPage, 1)
    assert.equal('printedPage' in pages.body.pages[0], false)

    const full = await bytesRequest(baseUrl, fileRoute)
    assert.equal(full.response.status, 200)
    assert.deepEqual(full.bytes, pdf)
    assert.equal(createHash('sha256').update(full.bytes).digest('hex'), expectedSha256)
    assert.equal(full.response.headers.get('content-type'), 'application/pdf')
    assert.equal(full.response.headers.get('content-length'), String(pdf.length))
    assert.equal(full.response.headers.get('accept-ranges'), 'bytes')
    const etag = full.response.headers.get('etag')
    assert.equal(etag, `"${expectedSha256}"`)
    assert.ok(full.response.headers.get('last-modified'))

    const head = await bytesRequest(baseUrl, fileRoute, { method: 'HEAD' })
    assert.equal(head.response.status, 200)
    assert.equal(head.bytes.length, 0)
    assert.equal(head.response.headers.get('content-type'), 'application/pdf')
    assert.equal(head.response.headers.get('content-length'), String(pdf.length))
    assert.equal(head.response.headers.get('accept-ranges'), 'bytes')
    assert.equal(head.response.headers.get('etag'), etag)

    const firstRange = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=0-99' },
    })
    assert.equal(firstRange.response.status, 206)
    assert.deepEqual(firstRange.bytes, pdf.subarray(0, 100))
    assert.equal(firstRange.response.headers.get('content-length'), '100')
    assert.equal(firstRange.response.headers.get('content-range'), `bytes 0-99/${pdf.length}`)

    const openRange = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=100-' },
    })
    assert.equal(openRange.response.status, 206)
    assert.deepEqual(openRange.bytes, pdf.subarray(100))
    assert.equal(openRange.response.headers.get('content-range'), `bytes 100-${pdf.length - 1}/${pdf.length}`)

    const suffixRange = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=-64' },
    })
    assert.equal(suffixRange.response.status, 206)
    assert.deepEqual(suffixRange.bytes, pdf.subarray(-64))
    assert.equal(suffixRange.response.headers.get('content-range'), `bytes ${pdf.length - 64}-${pdf.length - 1}/${pdf.length}`)

    const unsatisfiable = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=999999999-' },
    })
    assert.equal(unsatisfiable.response.status, 416)
    assert.equal(unsatisfiable.response.headers.get('content-range'), `bytes */${pdf.length}`)

    const malformed = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=not-a-range' },
    })
    assert.equal(malformed.response.status, 416)
    assert.equal(malformed.response.headers.get('content-range'), `bytes */${pdf.length}`)

    const multiple = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=0-1,2-3' },
    })
    assert.equal(multiple.response.status, 416)
    assert.equal(multiple.response.headers.get('content-range'), `bytes */${pdf.length}`)

    const notModified = await bytesRequest(baseUrl, fileRoute, {
      headers: { 'if-none-match': etag },
    })
    assert.equal(notModified.response.status, 304)
    assert.equal(notModified.bytes.length, 0)
    assert.equal(notModified.response.headers.get('etag'), etag)

    const conditionalRange = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=0-9', 'if-none-match': etag },
    })
    assert.equal(conditionalRange.response.status, 501)

    const ifRange = await bytesRequest(baseUrl, fileRoute, {
      headers: { range: 'bytes=0-9', 'if-range': etag },
    })
    assert.equal(ifRange.response.status, 501)

    const unknown = await bytesRequest(baseUrl, '/api/documents/does-not-exist/file')
    assert.equal(unknown.response.status, 404)
    assert.equal(unknown.bytes.toString('utf8').includes(root), false)

    const traversal = await bytesRequest(baseUrl, '/api/documents/%2e%2e%2fetc/passwd/file')
    assert.equal(traversal.response.status, 404)
    assert.equal(traversal.bytes.toString('utf8').includes(root), false)

    await runPdfJsSmokeTest(baseUrl, documentId, 1)

    console.log('document-list-api=pass')
    console.log('document-detail-api=pass')
    console.log('page-metadata-api=pass')
    console.log('complete-get-sha256=pass')
    console.log('head-empty-body=pass')
    console.log('range-start-end=pass')
    console.log('range-open-ended=pass')
    console.log('range-suffix=pass')
    console.log('range-unsatisfiable=pass')
    console.log('range-malformed-and-multiple-rejected=pass')
    console.log('if-none-match-304=pass')
    console.log('conditional-range-explicitly-unsupported=pass')
    console.log('if-range-explicitly-unsupported=pass')
    console.log('unknown-document-404=pass')
    console.log('path-traversal-contained=pass')
    console.log('pdfjs-http-url-page-count=pass')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
