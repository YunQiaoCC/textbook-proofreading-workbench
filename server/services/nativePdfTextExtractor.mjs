import { spawn } from 'node:child_process'

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function numberAttribute(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}="([0-9.+-]+)"`))
  const value = match ? Number(match[1]) : Number.NaN
  if (!Number.isFinite(value)) throw new Error(`malformed bbox output: missing ${name}`)
  return value
}

function classifyBlock(text, bbox, pageHeight) {
  const trimmed = text.trim()
  if (/^(?:[-*•]|\d+[.)、])\s*/u.test(trimmed)) return 'list'
  if (/\t| {3,}/u.test(trimmed)) return 'table'
  if (bbox.y + bbox.height >= pageHeight * 0.84 || /^[①②③④⑤⑥⑦⑧⑨⑩\[（(]?\d+[\]）)]/u.test(trimmed)) return 'footnote'
  if (trimmed.length <= 80 && /(?:章|节|编|篇|目录|序言|前言)$/u.test(trimmed)) return 'heading'
  return trimmed ? 'paragraph' : 'other'
}

export function parsePopplerBboxLayout(xhtml, { documentId, pdfPage }) {
  if (typeof xhtml !== 'string') throw new Error('malformed bbox output: not text')
  const pageMatch = xhtml.match(/<page\b([^>]*)>([\s\S]*?)<\/page>/i)
  if (!pageMatch) throw new Error('malformed bbox output: missing page')
  const pageWidth = numberAttribute(pageMatch[1], 'width')
  const pageHeight = numberAttribute(pageMatch[1], 'height')
  const blockMatches = [...pageMatch[2].matchAll(/<block\b([^>]*)>([\s\S]*?)<\/block>/gi)]
  const blocks = []
  let wordCount = 0
  let lineCount = 0

  for (const blockMatch of blockMatches) {
    const words = [...blockMatch[2].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/gi)]
      .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, '')))
    if (words.length === 0) continue
    wordCount += words.length
    const lines = [...blockMatch[2].matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/gi)]
    lineCount += Math.max(1, lines.length)
    const xMin = numberAttribute(blockMatch[1], 'xMin')
    const yMin = numberAttribute(blockMatch[1], 'yMin')
    const xMax = numberAttribute(blockMatch[1], 'xMax')
    const yMax = numberAttribute(blockMatch[1], 'yMax')
    if (xMax < xMin || yMax < yMin) throw new Error('malformed bbox output: inverted coordinates')
    const bbox = { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin }
    const text = lines.length
      ? lines.map((line) => [...line[1].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/gi)]
        .map((match) => decodeXml(match[1].replace(/<[^>]+>/g, ''))).join(' ')).join('\n')
      : words.join(' ')
    const order = blocks.length + 1
    blocks.push({
      id: `${documentId}-p${String(pdfPage).padStart(6, '0')}-b${String(order).padStart(4, '0')}`,
      documentId,
      pdfPage,
      order,
      type: classifyBlock(text, bbox, pageHeight),
      text,
      bbox,
      source: 'pdf_text',
    })
  }

  return {
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    lineCount,
    wordCount,
    bboxCount: blocks.length,
    coordinateSystem: {
      unit: 'pt',
      origin: 'top-left',
      xAxis: 'right',
      yAxis: 'down',
      pageWidth,
      pageHeight,
    },
  }
}

function runPdftotext({ binary, pdfPath, pdfPage, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-bbox-layout', '-enc', 'UTF-8', '-f', String(pdfPage), '-l', String(pdfPage), pdfPath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    let stdoutBytes = 0
    let stderr = ''
    let settled = false
    let forceKillTimer = null
    const terminate = () => {
      if (forceKillTimer) return
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceKillTimer.unref()
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      terminate()
      finish(new Error(`pdftotext page ${pdfPage} exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutputBytes) {
        terminate()
        finish(new Error(`pdftotext page ${pdfPage} exceeded output limit`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 32 * 1024) stderr += chunk.toString('utf8').slice(0, 32 * 1024 - stderr.length)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (code !== 0) {
        finish(new Error(`pdftotext failed for page ${pdfPage} (code=${code}, signal=${signal}): ${stderr.trim()}`))
        return
      }
      finish(null, Buffer.concat(stdout).toString('utf8'))
    })
  })
}

export class NativePdfTextExtractor {
  constructor({ pdftotextBin = process.env.PDFTOTEXT_BIN ?? 'pdftotext', timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
    this.pdftotextBin = pdftotextBin
    this.timeoutMs = timeoutMs
    this.maxOutputBytes = maxOutputBytes
  }

  async extractPage({ documentId, pdfPath, pdfPage }) {
    if (!/^[A-Za-z0-9-]+$/.test(documentId)) throw new Error('Invalid document identifier')
    if (!Number.isSafeInteger(pdfPage) || pdfPage < 1) throw new Error('Invalid one-based PDF page')
    const xhtml = await runPdftotext({
      binary: this.pdftotextBin,
      pdfPath,
      pdfPage,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    })
    return parsePopplerBboxLayout(xhtml, { documentId, pdfPage })
  }
}
