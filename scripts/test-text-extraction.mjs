#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createIngestionServer } from '../server/app.mjs'
import { NativePdfTextExtractor, parsePopplerBboxLayout } from '../server/services/nativePdfTextExtractor.mjs'
import { evaluateNativeTextQuality } from '../server/services/nativeTextQuality.mjs'
import { PdfPageVisualTriage } from '../server/services/pdfPageVisualTriage.mjs'

const timestamp = '2026-01-01T00:00:00.000Z'

function streamObject(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return Buffer.concat([Buffer.from(`<< /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')])
}

function makePdf(pageKinds) {
  const objects = []
  const pageIds = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  let nextId = 3
  for (let index = 0; index < pageKinds.length; index += 1) {
    const pageId = nextId++
    const contentId = nextId++
    pageIds.push(pageId)
    if (pageKinds[index] === 'text') {
      const fontId = nextId++
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
      objects[contentId] = streamObject(`BT /F1 14 Tf 72 720 Td (Page ${index + 1} native legal textbook content 2026.) Tj 0 -24 Td (Labor law paragraph punctuation, numbers 12345.) Tj ET`)
      objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    } else if (pageKinds[index] === 'visual') {
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentId} 0 R >>`
      objects[contentId] = streamObject('0 g 156 246 300 300 re f')
    } else {
      const imageId = nextId++
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
      objects[contentId] = streamObject('q 1 0 0 1 0 0 cm /Im1 Do Q')
      objects[imageId] = Buffer.concat([
        Buffer.from('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n'),
        Buffer.from([255, 255, 255]),
        Buffer.from('\nendstream'),
      ])
    }
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')]
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.concat(chunks).length
    chunks.push(Buffer.from(`${id} 0 obj\n`), Buffer.isBuffer(objects[id]) ? objects[id] : Buffer.from(objects[id]), Buffer.from('\nendobj\n'))
  }
  const xrefOffset = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  chunks.push(Buffer.from(xref))
  return Buffer.concat(chunks)
}

async function createDocument(app, id, pdf, pageCount) {
  const sha256 = createHash('sha256').update(pdf).digest('hex')
  const asset = await app.documentStorage.storeOriginalPdf({ documentId: id, byteSize: pdf.length, sha256, content: pdf })
  const document = { id, title: `${id}.pdf`, originalAssetId: asset.id, pageCount, processingStatus: 'ready', createdAt: timestamp, updatedAt: timestamp }
  const pages = Array.from({ length: pageCount }, (_, index) => ({ id: `${id}-page-${index + 1}`, documentId: id, pdfPage: index + 1 }))
  await app.documentRepository.saveBundle({ document, asset, pages })
}

async function listen(app) {
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${app.server.address().port}`
}

async function json(baseUrl, route, options) {
  const response = await fetch(baseUrl + route, options)
  const bodyText = await response.text()
  return { response, body: bodyText ? JSON.parse(bodyText) : null }
}

async function waitForTerminal(baseUrl, documentId) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await json(baseUrl, `/api/documents/${documentId}/text/status`)
    if (['completed', 'failed'].includes(result.body?.status)) return result.body
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('text extraction test timed out')
}

function fakeExtracted(documentId, pdfPage) {
  const text = `PDF page ${pdfPage} contains deterministic native textbook text and 2026 numbers.`
  return {
    text,
    lineCount: 1,
    wordCount: 10,
    bboxCount: 1,
    coordinateSystem: { unit: 'pt', origin: 'top-left', xAxis: 'right', yAxis: 'down', pageWidth: 612, pageHeight: 792 },
    blocks: [{ id: `${documentId}-p${String(pdfPage).padStart(6, '0')}-b0001`, documentId, pdfPage, order: 1, type: 'paragraph', text, source: 'pdf_text', bbox: { x: 72, y: 72, width: 300, height: 20 } }],
  }
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), (error) => error?.code === 'ENOENT')
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'textbook-text-extraction-'))
  try {
    const nativePdf = path.join(root, 'native.pdf')
    const imagePdf = path.join(root, 'image.pdf')
    const mixedPdf = path.join(root, 'mixed.pdf')
    const visualPdf = path.join(root, 'visual.pdf')
    await writeFile(nativePdf, makePdf(['text', 'text', 'text']))
    await writeFile(imagePdf, makePdf(['image']))
    await writeFile(mixedPdf, makePdf(['text', 'image']))
    await writeFile(visualPdf, makePdf(['visual']))
    const extractor = new NativePdfTextExtractor()
    const visualTriage = new PdfPageVisualTriage()

    for (const pdfPage of [1, 2, 3]) {
      const result = await extractor.extractPage({ documentId: 'mapping', pdfPath: nativePdf, pdfPage })
      assert.match(result.text, new RegExp(`Page ${pdfPage} native`))
      assert(result.blocks.every((block) => block.pdfPage === pdfPage))
      assert.equal(evaluateNativeTextQuality(result.text, result).usable, true)
      assert.deepEqual(result.coordinateSystem, { unit: 'pt', origin: 'top-left', xAxis: 'right', yAxis: 'down', pageWidth: 612, pageHeight: 792 })
    }
    const image = await extractor.extractPage({ documentId: 'image-only', pdfPath: imagePdf, pdfPage: 1 })
    assert.equal(evaluateNativeTextQuality(image.text, image).usable, false)
    const mixedOne = await extractor.extractPage({ documentId: 'mixed', pdfPath: mixedPdf, pdfPage: 1 })
    const mixedTwo = await extractor.extractPage({ documentId: 'mixed', pdfPath: mixedPdf, pdfPage: 2 })
    assert.equal(evaluateNativeTextQuality(mixedOne.text, mixedOne).usable, true)
    assert.equal(evaluateNativeTextQuality(mixedTwo.text, mixedTwo).usable, false)
    const blankVisual = await visualTriage.classifyPage({ pdfPath: imagePdf, pdfPage: 1 })
    const substantiveVisual = await visualTriage.classifyPage({ pdfPath: visualPdf, pdfPage: 1 })
    assert.equal(blankVisual.hasSubstantiveVisualContent, false)
    assert.equal(substantiveVisual.hasSubstantiveVisualContent, true)

    const shortTitle = evaluateNativeTextQuality('第三章 劳动合同', { lineCount: 1, wordCount: 2, bboxCount: 1 })
    assert.equal(shortTitle.classification, 'native_suspicious')
    assert(shortTitle.flags.includes('too_little_text'))
    const blank = evaluateNativeTextQuality('', { lineCount: 0, wordCount: 0, bboxCount: 0 })
    assert.equal(blank.classification, 'ocr_required')
    const noBbox = evaluateNativeTextQuality('Native text remains readable even when bbox data is unavailable.', { lineCount: 1, wordCount: 10, bboxCount: 0 })
    assert.equal(noBbox.classification, 'native_suspicious')
    assert(noBbox.flags.includes('no_bbox'))
    const spacedText = evaluateNativeTextQuality('劳 动 合 同 法 律 关 系 保 护 劳 动 者 合 法 权 益 与 社 会 保 障 制 度', { lineCount: 1, wordCount: 20, bboxCount: 1 })
    assert.equal(spacedText.classification, 'native_suspicious')
    assert(spacedText.flags.includes('excessive_cjk_spacing'))
    const garbled = evaluateNativeTextQuality(`${'�'.repeat(24)}无法可靠使用`, { lineCount: 1, wordCount: 2, bboxCount: 1 })
    assert.equal(garbled.classification, 'ocr_required')
    const normal = evaluateNativeTextQuality('This normal native legal textbook paragraph contains enough readable text.', { lineCount: 1, wordCount: 10, bboxCount: 1 })
    assert.equal(normal.classification, 'native_ready')

    assert.throws(() => parsePopplerBboxLayout('<html>broken</html>', { documentId: 'bad', pdfPage: 1 }), /malformed bbox output/)
    await assert.rejects(
      new NativePdfTextExtractor({ pdftotextBin: path.join(root, 'missing-pdftotext') }).extractPage({ documentId: 'failure', pdfPath: nativePdf, pdfPage: 1 }),
    )

    const fakeExtractor = { extractPage: async ({ documentId, pdfPage }) => fakeExtracted(documentId, pdfPage) }
    const fakeVisualTriage = {
      classifyPage: async ({ pdfPage }) => ({
        method: 'raster_ink', dpi: 36, inkPixelRatio: pdfPage === 2 ? 0.08 : 0,
        substantiveThreshold: 0.001, hasSubstantiveVisualContent: pdfPage === 2,
      }),
    }
    let app = await createIngestionServer({ storageRoot: root, nativeTextExtractor: fakeExtractor, pageVisualTriage: fakeVisualTriage })
    let baseUrl = await listen(app)
    await createDocument(app, 'api-mixed', makePdf(['text', 'image', 'image', 'text']), 4)
    const mixedExtractor = {
      extractPage: async ({ documentId, pdfPage }) => pdfPage === 1
        ? fakeExtracted(documentId, pdfPage)
        : pdfPage === 4
          ? { text: 'Native text remains readable even without bbox metadata for this page.', blocks: [], lineCount: 1, wordCount: 10, bboxCount: 0, coordinateSystem: { unit: 'pt', origin: 'top-left', xAxis: 'right', yAxis: 'down', pageWidth: 612, pageHeight: 792 } }
          : { text: '', blocks: [], lineCount: 0, wordCount: 0, bboxCount: 0, coordinateSystem: { unit: 'pt', origin: 'top-left', xAxis: 'right', yAxis: 'down', pageWidth: 612, pageHeight: 792 } },
    }
    app.documentTextService.extractor = mixedExtractor
    const started = await json(baseUrl, '/api/documents/api-mixed/text/extract', { method: 'POST' })
    assert.equal(started.response.status, 202)
    const completed = await waitForTerminal(baseUrl, 'api-mixed')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.nativeTextPages, 2)
    assert.equal(completed.nativeReadyPages, 1)
    assert.equal(completed.nativeSuspiciousPages, 1)
    assert.equal(completed.ocrRequiredPages, 1)
    assert.equal(completed.ocrNotNeededPages, 1)
    const pageOne = await json(baseUrl, '/api/documents/api-mixed/pages/1/text')
    const pageTwo = await json(baseUrl, '/api/documents/api-mixed/pages/2/text')
    const pageThree = await json(baseUrl, '/api/documents/api-mixed/pages/3/text')
    const pageFour = await json(baseUrl, '/api/documents/api-mixed/pages/4/text')
    assert.equal(pageOne.body.pdfPage, 1)
    assert.equal(pageOne.body.source, 'pdf_text')
    assert.equal(pageOne.body.status, 'ready')
    assert.equal(pageOne.body.classification, 'native_ready')
    assert.equal(pageTwo.body.pdfPage, 2)
    assert.equal(pageTwo.body.source, 'none')
    assert.equal(pageTwo.body.status, 'ocr_required')
    assert.equal(pageTwo.body.classification, 'ocr_required')
    assert.deepEqual(pageTwo.body.blocks, [])
    assert.equal(pageThree.body.source, 'none')
    assert.equal(pageThree.body.status, 'ready')
    assert.equal(pageThree.body.classification, 'ocr_not_needed')
    assert.equal(pageFour.body.source, 'pdf_text')
    assert.equal(pageFour.body.status, 'suspicious')
    assert.equal(pageFour.body.classification, 'native_suspicious')
    const triageReport = await app.textRepository.readTriageReport('api-mixed')
    assert.deepEqual(triageReport.candidates.map((candidate) => candidate.recommendedClass), ['ocr_required', 'ocr_not_needed', 'native_suspicious'])
    assert(triageReport.candidates.every((candidate) => !('text' in candidate)))

    const traversal = await json(baseUrl, '/api/documents/%2e%2e%2fetc/text/status')
    assert.equal(traversal.response.status, 404)

    await createDocument(app, 'recovery', makePdf(['text', 'text', 'text']), 3)
    const recoveredPage = { ...fakeExtracted('recovery', 1), documentId: 'recovery', pdfPage: 1, source: 'pdf_text', status: 'ready', classification: 'native_ready', charCount: 70, quality: evaluateNativeTextQuality('Recovered canonical page text remains readable after restart.', { lineCount: 1, wordCount: 8, bboxCount: 1 }), updatedAt: timestamp }
    delete recoveredPage.text
    delete recoveredPage.lineCount
    delete recoveredPage.wordCount
    delete recoveredPage.bboxCount
    await app.textRepository.writePage(recoveredPage)
    await app.textRepository.writeSummary({ id: 'recovery-job', documentId: 'recovery', status: 'processing', totalPages: 3, processedPages: 1, nativeTextPages: 1, nativeReadyPages: 1, nativeSuspiciousPages: 0, ocrRequiredPages: 0, ocrNotNeededPages: 0, failedPages: 0, createdAt: timestamp, startedAt: timestamp, updatedAt: timestamp })
    await app.close()

    app = await createIngestionServer({ storageRoot: root, nativeTextExtractor: fakeExtractor, pageVisualTriage: fakeVisualTriage })
    baseUrl = await listen(app)
    const recoveredBeforeCompletion = await json(baseUrl, '/api/documents/recovery/pages/1/text')
    assert.equal(recoveredBeforeCompletion.body.status, 'ready')
    const recovered = await waitForTerminal(baseUrl, 'recovery')
    assert.equal(recovered.status, 'completed')
    assert.equal(recovered.processedPages, 3)

    const deleted = await json(baseUrl, '/api/documents/api-mixed', { method: 'DELETE' })
    assert.equal(deleted.response.status, 204)
    await assertMissing(path.join(root, 'text', 'api-mixed'))
    await assertMissing(path.join(root, 'metadata', 'text', 'api-mixed.json'))
    await assertMissing(path.join(root, 'metadata', 'text', 'api-mixed-ocr-triage.json'))

    await app.close()
    console.log('classification=short-title:suspicious blank:not-needed image-text:ocr no-bbox:suspicious extra-spacing:suspicious garbled:ocr normal:ready')
    console.log('mixed=page1:native_ready,page2:ocr_required,page3:ocr_not_needed,page4:native_suspicious triage-report=no-text')
    console.log('page-mapping=1,middle,last malformed-bbox=rejected child-failure=rejected')
    console.log('restart-recovery=resumed document-delete-text-cascade=passed traversal=rejected')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
