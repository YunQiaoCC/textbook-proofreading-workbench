import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const DEFAULT_DPI = 36
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const INK_PIXEL_VALUE = 245
const SUBSTANTIVE_THRESHOLD = 0.02
const EDGE_MARGIN_RATIO = 0.03

export function analyzePgmInk(buffer, { dpi = DEFAULT_DPI } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('invalid PGM output')
  let offset = 0
  const tokens = []
  while (tokens.length < 4) {
    while (offset < buffer.length && /\s/.test(String.fromCharCode(buffer[offset]))) offset += 1
    if (buffer[offset] === 0x23) {
      while (offset < buffer.length && buffer[offset] !== 0x0a) offset += 1
      continue
    }
    const start = offset
    while (offset < buffer.length && !/\s/.test(String.fromCharCode(buffer[offset]))) offset += 1
    if (start === offset) throw new Error('invalid PGM header')
    tokens.push(buffer.subarray(start, offset).toString('ascii'))
  }
  if (tokens[0] !== 'P5') throw new Error('unsupported PGM format')
  const width = Number(tokens[1])
  const height = Number(tokens[2])
  const maxValue = Number(tokens[3])
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 || maxValue !== 255) {
    throw new Error('invalid PGM dimensions')
  }
  if (buffer[offset] === 0x0d && buffer[offset + 1] === 0x0a) offset += 2
  else if (/\s/.test(String.fromCharCode(buffer[offset]))) offset += 1
  const expectedBytes = width * height
  if (buffer.length - offset < expectedBytes) throw new Error('truncated PGM pixels')

  const marginX = Math.max(1, Math.floor(width * EDGE_MARGIN_RATIO))
  const marginY = Math.max(1, Math.floor(height * EDGE_MARGIN_RATIO))
  let inspectedPixels = 0
  let inkPixels = 0
  for (let y = marginY; y < height - marginY; y += 1) {
    const row = offset + y * width
    for (let x = marginX; x < width - marginX; x += 1) {
      inspectedPixels += 1
      if (buffer[row + x] < INK_PIXEL_VALUE) inkPixels += 1
    }
  }
  const inkPixelRatio = inkPixels / Math.max(1, inspectedPixels)
  return {
    method: 'raster_ink',
    dpi,
    inkPixelRatio,
    substantiveThreshold: SUBSTANTIVE_THRESHOLD,
    hasSubstantiveVisualContent: inkPixelRatio >= SUBSTANTIVE_THRESHOLD,
  }
}

async function renderPage({ binary, pdfPath, pdfPage, dpi, timeoutMs }) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pdf-page-visual-'))
  const outputPrefix = path.join(temporaryDirectory, 'page')
  const outputPath = `${outputPrefix}.pgm`
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(binary, ['-f', String(pdfPage), '-l', String(pdfPage), '-singlefile', '-r', String(dpi), '-gray', '-q', pdfPath, outputPrefix], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      let settled = false
      let timeoutError = null
      let forceKillTimer
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(forceKillTimer)
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => {
        timeoutError = new Error(`page visual triage exceeded ${timeoutMs}ms`)
        child.kill('SIGTERM')
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      }, timeoutMs)
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8').slice(0, 16 * 1024 - stderr.length)
      })
      child.once('error', (error) => finish(error))
      child.once('close', (code, signal) => {
        if (timeoutError) finish(timeoutError)
        else if (code === 0) finish(null)
        else finish(new Error(`pdftoppm failed (code=${code}, signal=${signal}): ${stderr.trim()}`))
      })
    })
    const outputStat = await stat(outputPath)
    if (outputStat.size > MAX_OUTPUT_BYTES) throw new Error('page visual triage exceeded output limit')
    return await readFile(outputPath)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export class PdfPageVisualTriage {
  constructor({ pdftoppmBin = process.env.PDFTOPPM_BIN ?? 'pdftoppm', dpi = DEFAULT_DPI, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.pdftoppmBin = pdftoppmBin
    this.dpi = dpi
    this.timeoutMs = timeoutMs
  }

  async classifyPage({ pdfPath, pdfPage }) {
    if (!Number.isSafeInteger(pdfPage) || pdfPage < 1) throw new Error('Invalid one-based PDF page')
    const pgm = await renderPage({
      binary: this.pdftoppmBin,
      pdfPath,
      pdfPage,
      dpi: this.dpi,
      timeoutMs: this.timeoutMs,
    })
    return analyzePgmInk(pgm, { dpi: this.dpi })
  }
}
