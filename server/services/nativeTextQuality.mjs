const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const SUSPICIOUS = /[\ue000-\uf8ff]/u

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
  const flags = []

  if (nonWhitespaceCharCount === 0) flags.push('empty_text')
  else if (nonWhitespaceCharCount < 20) flags.push('too_little_text')
  if (replacementCharacterCount > 0 && replacementRatio > 0.02) flags.push('replacement_chars')
  if (printableRatio < 0.85) flags.push('low_printable_ratio')
  if (suspiciousGlyphRatio > 0.1) flags.push('suspicious_glyphs')
  if (bboxCount === 0 && nonWhitespaceCharCount > 0 && !flags.includes('too_little_text')) {
    flags.push('suspicious_glyphs')
  }

  const usable = flags.length === 0
  if (usable) flags.push('usable_native_text')

  return {
    usable,
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
  }
}
