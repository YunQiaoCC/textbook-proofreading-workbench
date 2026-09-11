#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')
const cliPath = path.join(projectRoot, 'scripts', 'inspect-pdf.mjs')

function streamObject(content) {
  const body = Buffer.from(content)
  return Buffer.concat([
    Buffer.from(`<< /Length ${body.length} >>\nstream\n`),
    body,
    Buffer.from('\nendstream'),
  ])
}

function makePdf(kind) {
  const objects = []
  const textPageOne =
    'BT /F1 18 Tf 72 720 Td (Legal textbook text.) Tj 0 -28 Td (Second body line.) Tj ET'
  const textPageTwo = 'BT /F1 12 Tf 72 720 Td (12) Tj ET'

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'

  if (kind === 'text') {
    objects[3] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    objects[4] = streamObject(textPageOne)
    objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    objects[6] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>'
    objects[7] = streamObject(textPageTwo)
  } else {
    objects[3] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>'
    objects[4] = streamObject('q 1 0 0 1 0 0 cm /Im1 Do Q')
    objects[5] = Buffer.concat([
      Buffer.from(
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n',
      ),
      Buffer.from([255, 255, 255]),
      Buffer.from('\nendstream'),
    ])
    objects[6] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 7 0 R >>'
    objects[7] = streamObject('q 1 0 0 1 0 0 cm /Im1 Do Q')
  }

  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')]
  const offsets = [0]
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.concat(chunks).length
    const body = Buffer.isBuffer(objects[id]) ? objects[id] : Buffer.from(objects[id])
    chunks.push(Buffer.from(`${id} 0 obj\n`), body, Buffer.from('\nendobj\n'))
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

async function runCli(filePath, jsonPath, toolDir) {
  const startedAt = performance.now()
  try {
    const result = await execFileAsync(process.execPath, [cliPath, filePath, '--json', jsonPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PDFINFO_BIN: path.join(toolDir, 'fake-pdfinfo.mjs'),
        PDFTOTEXT_BIN: path.join(toolDir, 'fake-pdftotext.mjs'),
      },
      maxBuffer: 1024 * 1024,
    })
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      elapsedMs: Math.round(performance.now() - startedAt),
    }
  }
}

async function main() {
  const testDir = await mkdtemp(path.join(tmpdir(), 'textbook-pdf-inspection-'))
  try {
    const toolDir = path.join(testDir, 'tools')
    await mkdir(toolDir)
    const pdfInfoTool = `#!/usr/bin/env node
console.log('Pages: 2')
console.log('PDF version: 1.4')
console.log('Encrypted: no')
console.log('Page size: 612 x 792 pts (letter)')
console.log('Page rot: 0')
`
    const pdfTextTool = `#!/usr/bin/env node
const input = process.argv.at(-2)
if (input.includes('text-layer')) {
  process.stdout.write('Legal textbook body text has enough characters.\\nSecond body line.\\f12')
} else {
  process.stdout.write('\\f\\f')
}
`
    await writeFile(path.join(toolDir, 'fake-pdfinfo.mjs'), pdfInfoTool, 'utf8')
    await writeFile(path.join(toolDir, 'fake-pdftotext.mjs'), pdfTextTool, 'utf8')
    await chmod(path.join(toolDir, 'fake-pdfinfo.mjs'), 0o755)
    await chmod(path.join(toolDir, 'fake-pdftotext.mjs'), 0o755)

    const textPdf = path.join(testDir, 'text-layer.pdf')
    const imagePdf = path.join(testDir, 'image-only.pdf')
    const malformed = path.join(testDir, 'malformed.pdf')
    await writeFile(textPdf, makePdf('text'))
    await writeFile(imagePdf, makePdf('image'))
    await writeFile(malformed, 'not a PDF')

    const textReportPath = path.join(testDir, 'text-report.json')
    const imageReportPath = path.join(testDir, 'image-report.json')
    const textRun = await runCli(textPdf, textReportPath, toolDir)
    const imageRun = await runCli(imagePdf, imageReportPath, toolDir)
    const malformedRun = await runCli(
      malformed,
      path.join(testDir, 'malformed-report.json'),
      toolDir,
    )
    const textReport = JSON.parse(await readFile(textReportPath, 'utf8'))
    const imageReport = JSON.parse(await readFile(imageReportPath, 'utf8'))

    assert.equal(textRun.code, 0)
    assert.equal(textReport.pageCount, 2)
    assert.equal(textReport.textLayer.pagesWithText, 1)
    assert.equal(textReport.textLayer.pagesWithoutText, 1)
    assert.equal(textReport.textLayer.scannedPageRatio, 0.5)
    assert.equal(textReport.pages[0].hasTextLayer, true)
    assert.equal(textReport.pages[1].hasTextLayer, false)
    assert.equal(textReport.sha256, createHash('sha256').update(await readFile(textPdf)).digest('hex'))

    assert.equal(imageRun.code, 0)
    assert.equal(imageReport.pageCount, 2)
    assert.equal(imageReport.textLayer.pagesWithText, 0)
    assert.equal(imageReport.textLayer.pagesWithoutText, 2)
    assert.equal(imageReport.textLayer.scannedPageRatio, 1)

    assert.notEqual(malformedRun.code, 0)
    assert.match(malformedRun.stderr, /%PDF-/)

    const textStat = await stat(textPdf)
    const imageStat = await stat(imagePdf)
    console.log(`text-fixture bytes=${textStat.size} elapsedMs=${textRun.elapsedMs} scannedPageRatio=${textReport.textLayer.scannedPageRatio}`)
    console.log(`image-fixture bytes=${imageStat.size} elapsedMs=${imageRun.elapsedMs} scannedPageRatio=${imageReport.textLayer.scannedPageRatio}`)
    console.log('malformed-fixture rejected=yes')
    console.log('temporary-files-cleaned=yes')
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
}

await main()
