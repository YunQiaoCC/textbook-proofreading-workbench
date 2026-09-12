const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const SUSPICIOUS = /[\ue000-\uf8ff]/u
const CJK_SPACING = /(?=([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]))/gu

const HARD_REPLACEMENT_RATIO = 0.15
const HARD_PRINTABLE_RATIO = 0.6
const HARD_SUSPICIOUS_GLYPH_RATIO = 0.3
const SOFT_REPLACEMENT_RATIO = 0.02
const SOFT_PRINTABLE_RATIO = 0.85
const SOFT_SUSPICIOUS_GLYPH_RATIO = 0.1
const EXCESSIVE_CJK_SPACING_RATIO = 0.42
const FRAGMENTED_LAYOUT_MIN_BLOCKS = 20
const FRAGMENTED_LAYOUT_MAX_AVERAGE_CHARS = 20

function countMatchingCharacters(text, expression) {
  let count = 0
  for (const character of text) {
    if (expression.test(character)) count += 1
  }
  return count
}

export function evaluateNativeTextQuality(text, { lineCount = 0, wordCount = 0, bboxCount = 0 } = {}) {
  const value = typeof text === 'string' ? text : ''
  const characters = [...value]
  const charCount = characters.length
  const nonWhitespaceCharCount = countMatchingCharacters(value, /\S/u)
  const replacementCharacterCount = countMatchingCharacters(value, /\ufffd/u)
  const cjkCharCount = countMatchingCharacters(value, CJK)
  const controlCharacterCount = countMatchingCharacters(value, CONTROL)
  const suspiciousGlyphCount = countMatchingCharacters(value, SUSPICIOUS)
  const denominator = Math.max(1, charCount)
  const nonWhitespaceDenominator = Math.max(1, nonWhitespaceCharCount)
  const printableRatio = (charCount - controlCharacterCount - replacementCharacterCount) / denominator
  const replacementRatio = replacementCharacterCount / nonWhitespaceDenominator
  const suspiciousGlyphRatio = suspiciousGlyphCount / nonWhitespaceDenominator
  const cjkSpacingCount = [...value.matchAll(CJK_SPACING)].length
  const cjkSpacingRatio = cjkSpacingCount / Math.max(1, cjkCharCount - 1)
  const averageNonWhitespaceCharsPerBlock = nonWhitespaceCharCount / Math.max(1, bboxCount)
  const flags = []
  const hardFlags = []
  const suspiciousFlags = []

  if (nonWhitespaceCharCount === 0) hardFlags.push('empty_text')
  else if (nonWhitespaceCharCount < 20) suspiciousFlags.push('too_little_text')
  if (replacementCharacterCount > 0 && replacementRatio > SOFT_REPLACEMENT_RATIO) {
    ;(replacementRatio >= HARD_REPLACEMENT_RATIO ? hardFlags : suspiciousFlags).push('replacement_chars')
  }
  if (printableRatio < SOFT_PRINTABLE_RATIO) {
    ;(printableRatio < HARD_PRINTABLE_RATIO ? hardFlags : suspiciousFlags).push('low_printable_ratio')
  }
  if (suspiciousGlyphRatio > SOFT_SUSPICIOUS_GLYPH_RATIO) {
    ;(suspiciousGlyphRatio >= HARD_SUSPICIOUS_GLYPH_RATIO ? hardFlags : suspiciousFlags).push('suspicious_glyphs')
  }
  if (bboxCount === 0 && nonWhitespaceCharCount > 0) suspiciousFlags.push('no_bbox')
  if (cjkCharCount >= 20 && cjkSpacingRatio > EXCESSIVE_CJK_SPACING_RATIO) {
    suspiciousFlags.push('excessive_cjk_spacing')
  }
  if (
    bboxCount >= FRAGMENTED_LAYOUT_MIN_BLOCKS &&
    averageNonWhitespaceCharsPerBlock < FRAGMENTED_LAYOUT_MAX_AVERAGE_CHARS
  ) {
    suspiciousFlags.push('fragmented_layout')
  }

  flags.push(...new Set([...hardFlags, ...suspiciousFlags]))
  const hardFailure = hardFlags.length > 0
  const suspicious = !hardFailure && suspiciousFlags.length > 0
  const usable = !hardFailure
  const classification = hardFailure ? 'ocr_required' : suspicious ? 'native_suspicious' : 'native_ready'
  if (classification === 'native_ready') flags.push('usable_native_text')

  return {
    usable,
    suspicious,
    hardFailure,
    classification,
    flags,
    charCount,
    nonWhitespaceCharCount,
    replacementCharacterCount,
    printableRatio,
    cjkCharCount,
    cjkRatio: cjkCharCount / nonWhitespaceDenominator,
    lineCount,
    wordCount,
    textItemCount: wordCount,
    bboxCount,
    controlCharacterRatio: controlCharacterCount / denominator,
    suspiciousGlyphRatio,
    cjkSpacingRatio,
    averageNonWhitespaceCharsPerBlock,
  }
}
