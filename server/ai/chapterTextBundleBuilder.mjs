function pageCategory(artifact) {
  if (!artifact || artifact.status === 'failed') return 'unavailable'
  if (artifact.classification === 'ocr_not_needed') return 'blank'
  if (artifact.classification === 'native_ready' && artifact.status === 'ready') return 'ready'
  if (artifact.classification === 'native_suspicious' && Array.isArray(artifact.blocks) && artifact.blocks.length) {
    return 'suspicious'
  }
  return 'unavailable'
}

function providerPage(pdfPage, artifact, category) {
  const reliability = category === 'ready' ? 'high' : category === 'suspicious' ? 'medium' : 'low'
  return {
    pdfPage,
    extractionStatus: category === 'blank' ? 'blank' : category === 'unavailable' ? 'unavailable' : 'available',
    extractionReliability: reliability,
    ...(category === 'suspicious' ? { extractionWarning: 'native_text_suspicious' } : {}),
    blocks: ['ready', 'suspicious'].includes(category)
      ? (artifact.blocks ?? []).filter((block) => typeof block.text === 'string' && block.text.length).map((block) => ({
        blockId: block.id,
        text: block.text,
      }))
      : [],
  }
}

export class ChapterTextBundleBuilder {
  constructor({ documentRepository, textRepository }) {
    this.documentRepository = documentRepository
    this.textRepository = textRepository
  }

  async build(documentId, chapterId) {
    const chapter = await this.documentRepository.getChapter(documentId, chapterId)
    if (!chapter) throw Object.assign(new Error('chapter not found'), { code: 'chapter_not_found' })
    const pages = []
    const counts = { ready: 0, suspicious: 0, unavailable: 0, blank: 0 }
    for (let pdfPage = chapter.startPdfPage; pdfPage <= chapter.endPdfPage; pdfPage += 1) {
      const artifact = await this.textRepository.readPage(documentId, pdfPage)
      const category = pageCategory(artifact)
      counts[category] += 1
      pages.push(providerPage(pdfPage, artifact, category))
    }
    const coverage = {
      totalPages: pages.length,
      readyPages: counts.ready,
      suspiciousPages: counts.suspicious,
      unavailablePages: counts.unavailable,
      blankPages: counts.blank,
      coveredTextPages: counts.ready + counts.suspicious,
      complete: counts.suspicious === 0 && counts.unavailable === 0,
    }
    const characterCount = pages.reduce(
      (sum, page) => sum + page.blocks.reduce((pageSum, block) => pageSum + block.text.length, 0),
      0,
    )
    return {
      documentId,
      chapterId,
      startPdfPage: chapter.startPdfPage,
      endPdfPage: chapter.endPdfPage,
      pages,
      coverage,
      characterCount,
    }
  }
}
