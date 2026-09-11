#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, open, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const TEXT_HEURISTIC =
  'A page is considered text-backed when pdftotext yields at least 12 letters or digits and either at least 2 meaningful lines or at least 40 meaningful characters; isolated page numbers and characters do not qualify.'
const MAX_CAPTURED_OUTPUT = 64 * 1024

function warning(code, message, severity = 'warning', pdfPage) {
  return {
    code,
    message,
    severity,
    ...(pdfPage === undefined ? {} : { pdfPage }),
  }
}

function parseArguments(args) {
  let inputPath
  let jsonPath

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]

    if (argument === '--json') {
      jsonPath = args[index + 1]
      index += 1
      if (!jsonPath) {
        throw new Error('--json requires an output path')
      }
      continue
    }

    if (argument.startsWith('--json=')) {
      jsonPath = argument.slice('--json='.length)
      if (!jsonPath) {
        throw new Error('--json requires an output path')
      }
      continue
    }

    if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`)
    }

    if (inputPath) {
      throw new Error('Only one PDF path may be inspected at a time')
    }

    inputPath = argument
  }

  if (!inputPath) {
    throw new Error('Usage: npm run inspect:pdf -- /absolute/path/to/file.pdf [--json report.json]')
  }

  if (!path.isAbsolute(inputPath)) {
    throw new Error('The PDF path must be absolute')
  }

  return {
    inputPath: path.resolve(inputPath),
    jsonPath: jsonPath ? path.resolve(jsonPath) : undefined,
  }
}

async function validatePdfFile(filePath) {
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile()) {
    throw new Error(`Input path is not a regular file: ${filePath}`)
  }

  const handle = await open(filePath, 'r')
  try {
    const prefix = Buffer.alloc(5)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    if (prefix.subarray(0, bytesRead).toString('ascii') !== '%PDF-') {
      throw new Error('Input does not start with the PDF magic number %PDF-')
    }
  } finally {
    await handle.close()
  }

  return fileStat
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(filePath, { highWaterMark: 1024 * 1024 })

    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex')))
  })
}

function captureProcessOutput(command, args) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child

    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ available: false, exitCode: null, error })
      return
    }

    const appendOutput = (target, chunk) => {
      const remaining = MAX_CAPTURED_OUTPUT - target.length
      return remaining > 0 ? target + chunk.toString('utf8', 0, remaining) : target
    }

    child.stdout.on('data', (chunk) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => {
      if (!settled) {
        settled = true
        resolve({ available: false, exitCode: null, error })
      }
    })
    child.on('close', (exitCode) => {
      if (!settled) {
        settled = true
        resolve({ available: true, exitCode, stdout, stderr })
      }
    })
  })
}

function parsePdfInfoOutput(output) {
  const pages = Number.parseInt(output.match(/^Pages:\s+(\d+)/im)?.[1] ?? '', 10)
  const pageCount = Number.isInteger(pages) && pages > 0 ? pages : null
  const pdfVersion = output.match(/^PDF version:\s+(.+)$/im)?.[1]?.trim()
  const encryptedValue = output.match(/^Encrypted:\s+(yes|no)$/im)?.[1]?.toLowerCase()
  const encrypted =
    encryptedValue === 'yes' ? true : encryptedValue === 'no' ? false : null
  const pageSize = output.match(
    /^Page size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/im,
  )
  const rotation = Number.parseInt(
    output.match(/^Page rot:\s+(-?\d+)$/im)?.[1] ?? '',
    10,
  )

  return {
    pageCount,
    pdfVersion,
    encrypted,
    dimension: pageSize
      ? {
          width: Number.parseFloat(pageSize[1]),
          height: Number.parseFloat(pageSize[2]),
          unit: 'pt',
        }
      : { width: null, height: null, unit: 'pt' },
    rotation: Number.isInteger(rotation) ? rotation : null,
  }
}

async function inspectPdfInfo(filePath) {
  const command = process.env.PDFINFO_BIN || 'pdfinfo'
  const result = await captureProcessOutput(command, [filePath])

  if (!result.available) {
    return {
      ...parsePdfInfoOutput(''),
      warnings: [
        warning(
          'pdfinfo-unavailable',
          `Unable to run ${command}; page metadata is unavailable.`,
        ),
      ],
    }
  }

  if (result.exitCode !== 0) {
    return {
      ...parsePdfInfoOutput(''),
      warnings: [
        warning(
          'pdfinfo-failed',
          `${command} exited with code ${result.exitCode}: ${result.stderr.trim() || 'no stderr'}`,
        ),
      ],
    }
  }

  const parsed = parsePdfInfoOutput(result.stdout)
  const warnings = []
  if (parsed.pageCount === null) {
    warnings.push(
      warning('pdfinfo-page-count-unavailable', 'pdfinfo did not provide a page count.'),
    )
  }
  if (!parsed.pdfVersion) {
    warnings.push(
      warning('pdfinfo-version-unavailable', 'pdfinfo did not provide a PDF version.'),
    )
  }
  if (parsed.encrypted === null) {
    warnings.push(
      warning('pdfinfo-encryption-unavailable', 'pdfinfo did not provide encryption status.'),
    )
  }
  if (parsed.dimension.width === null) {
    warnings.push(
      warning('pdfinfo-page-size-unavailable', 'pdfinfo did not provide a page size.'),
    )
  }

  return { ...parsed, warnings }
}

function createPageTextStats() {
  return {
    textCharacterCount: 0,
    meaningfulCharacterCount: 0,
    meaningfulLineCount: 0,
    lineHasMeaningfulCharacter: false,
  }
}

function isMeaningfulCharacter(character) {
  return /[\p{L}\p{N}]/u.test(character)
}

function finalizeTextPage(state) {
  const page = state.pages[state.pageIndex] ?? createPageTextStats()
  if (page.lineHasMeaningfulCharacter) {
    page.meaningfulLineCount += 1
  }
  page.lineHasMeaningfulCharacter = false
  state.pages[state.pageIndex] = page
  state.pageIndex += 1
}

function consumeTextChunk(state, text) {
  for (const character of text) {
    if (character === '\f') {
      finalizeTextPage(state)
      continue
    }

    const page = state.pages[state.pageIndex] ?? createPageTextStats()
    state.pages[state.pageIndex] = page

    if (character === '\n') {
      if (page.lineHasMeaningfulCharacter) {
        page.meaningfulLineCount += 1
      }
      page.lineHasMeaningfulCharacter = false
      continue
    }

    if (character === '\r' || /\s/u.test(character)) {
      continue
    }

    page.textCharacterCount += 1
    if (isMeaningfulCharacter(character)) {
      page.meaningfulCharacterCount += 1
      page.lineHasMeaningfulCharacter = true
    }
  }
}

function materializeTextPages(state, expectedPageCount) {
  if (state.pageIndex < state.pages.length) {
    finalizeTextPage(state)
  }

  const pageCount = Math.max(expectedPageCount ?? 0, state.pages.length)
  while (state.pages.length < pageCount) {
    state.pages.push(createPageTextStats())
  }

  return state.pages.slice(0, pageCount).map((page) => {
    const hasTextLayer =
      page.meaningfulCharacterCount >= 12 &&
      (page.meaningfulLineCount >= 2 || page.meaningfulCharacterCount >= 40)
    return {
      textCharacterCount: page.textCharacterCount,
      hasTextLayer,
      suspicious: page.meaningfulCharacterCount > 0 && !hasTextLayer,
    }
  })
}

async function inspectTextLayer(filePath, expectedPageCount) {
  const command = process.env.PDFTOTEXT_BIN || 'pdftotext'
  let child
  try {
    child = spawn(command, ['-layout', '-enc', 'UTF-8', filePath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return {
      available: false,
      pages: [],
      warnings: [
        warning(
          'pdftotext-unavailable',
          `Unable to run ${command}; text-layer metadata is unavailable.`,
        ),
      ],
    }
  }

  const state = { pages: [], pageIndex: 0 }
  const decoder = new StringDecoder('utf8')
  let stderr = ''
  let spawnError

  child.stdout.on('data', (chunk) => {
    consumeTextChunk(state, decoder.write(chunk))
  })
  child.stderr.on('data', (chunk) => {
    if (stderr.length < MAX_CAPTURED_OUTPUT) {
      stderr += chunk.toString('utf8', 0, MAX_CAPTURED_OUTPUT - stderr.length)
    }
  })
  child.on('error', (error) => {
    spawnError = error
  })

  const exitCode = await new Promise((resolve) => child.on('close', resolve))
  consumeTextChunk(state, decoder.end())

  if (spawnError || exitCode !== 0) {
    return {
      available: false,
      pages: [],
      warnings: [
        warning(
          'pdftotext-failed',
          `${command} exited with code ${exitCode ?? 'unknown'}: ${stderr.trim() || spawnError?.message || 'no stderr'}`,
        ),
      ],
    }
  }

  const pages = materializeTextPages(state, expectedPageCount)
  const warnings = [
    warning(
      'text-item-count-unavailable',
      'pdftotext provides page text, not reliable text-item counts; textItemCount is null.',
      'info',
    ),
  ]
  if (expectedPageCount !== null && pages.length !== expectedPageCount) {
    warnings.push(
      warning(
        'text-page-count-mismatch',
        `pdftotext yielded ${pages.length} page segments while pdfinfo reported ${expectedPageCount}.`,
      ),
    )
  }

  return { available: true, pages, warnings }
}

function createPageReports(pageCount, dimension, rotation, textPages, textAvailable) {
  return Array.from({ length: pageCount }, (_, index) => {
    const textPage = textPages[index]
    const pageWarnings = []
    if (textPage?.suspicious) {
      pageWarnings.push(
        warning(
          'text-layer-heuristic',
          'Page contains some letters or digits but does not meet the full-text heuristic.',
          'info',
          index + 1,
        ),
      )
    }

    return {
      pdfPage: index + 1,
      width: dimension.width,
      height: dimension.height,
      rotation,
      hasTextLayer: textAvailable ? textPage?.hasTextLayer ?? false : null,
      textCharacterCount: textAvailable ? textPage?.textCharacterCount ?? 0 : null,
      textItemCount: null,
      suspicious: textAvailable ? textPage?.suspicious ?? false : null,
      warnings: pageWarnings,
    }
  })
}

async function inspectPdf(filePath) {
  const fileStat = await validatePdfFile(filePath)
  const [sha256, pdfInfo] = await Promise.all([
    sha256File(filePath),
    inspectPdfInfo(filePath),
  ])
  const textLayer = await inspectTextLayer(filePath, pdfInfo.pageCount)
  const observedPageCount = textLayer.pages.length || null
  const pageCount = pdfInfo.pageCount ?? observedPageCount
  const pages = createPageReports(
    pageCount ?? 0,
    pdfInfo.dimension,
    pdfInfo.rotation,
    textLayer.pages,
    textLayer.available,
  )
  const pagesWithText = textLayer.available
    ? pages.filter((page) => page.hasTextLayer).length
    : null
  const pagesWithoutText = textLayer.available
    ? (pageCount ?? pages.length) - pagesWithText
    : null
  const suspiciousPages = pages.filter((page) => page.suspicious).length
  const warnings = [...pdfInfo.warnings, ...textLayer.warnings]

  if (pdfInfo.pageCount === null && observedPageCount !== null) {
    warnings.push(
      warning(
        'page-count-from-pdftotext',
        'Page count was inferred from pdftotext separators because pdfinfo did not provide it.',
        'info',
      ),
    )
  }
  if (pdfInfo.dimension.width !== null && (pageCount ?? 0) > 1) {
    warnings.push(
      warning(
        'document-level-page-dimensions',
        'Page dimensions come from pdfinfo document metadata and are applied to each page; mixed page sizes are not independently verified.',
        'info',
      ),
    )
  }
  if (suspiciousPages > 0) {
    warnings.push(
      warning(
        'suspicious-text-pages',
        `${suspiciousPages} page(s) contain sparse text that did not meet the full-text heuristic.`,
        'info',
      ),
    )
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    byteSize: fileStat.size,
    sha256,
    pageCount,
    pdfVersion: pdfInfo.pdfVersion,
    encrypted: pdfInfo.encrypted,
    pageDimensions: Array.from(
      { length: pageCount ?? 0 },
      () => pdfInfo.dimension,
    ),
    pages,
    textLayer: {
      available: textLayer.available,
      ...(textLayer.available ? { method: 'pdftotext' } : {}),
      pagesWithText,
      pagesWithoutText,
      scannedPageRatio:
        textLayer.available && pageCount
          ? pagesWithoutText / pageCount
          : null,
      heuristic: TEXT_HEURISTIC,
    },
    warnings,
    inspectedAt: new Date().toISOString(),
  }
}

function printSummary(report, jsonPath) {
  console.log('PDF inspection report')
  console.log(`file: ${report.filePath}`)
  console.log(`size: ${report.byteSize} bytes`)
  console.log(`sha256: ${report.sha256}`)
  console.log(`pages: ${report.pageCount ?? 'unknown'}`)
  console.log(`pdfVersion: ${report.pdfVersion ?? 'unknown'}`)
  console.log(`encrypted: ${report.encrypted === null ? 'unknown' : report.encrypted}`)
  console.log(
    `text layer: ${report.textLayer.available ? 'available' : 'unavailable'}; pagesWithText=${report.textLayer.pagesWithText ?? 'unknown'}; pagesWithoutText=${report.textLayer.pagesWithoutText ?? 'unknown'}; scannedPageRatio=${report.textLayer.scannedPageRatio ?? 'unknown'}`,
  )
  if (report.warnings.length > 0) {
    console.log('warnings:')
    for (const item of report.warnings) {
      console.log(`- [${item.severity}] ${item.code}: ${item.message}`)
    }
  }
  if (jsonPath) {
    console.log(`jsonReport: ${jsonPath}`)
  }
}

async function main() {
  const { inputPath, jsonPath } = parseArguments(process.argv.slice(2))
  const report = await inspectPdf(inputPath)
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  }
  printSummary(report, jsonPath)
}

try {
  await main()
} catch (error) {
  console.error(`PDF inspection failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
