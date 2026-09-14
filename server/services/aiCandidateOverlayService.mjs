const SUPPORTED_RESOLUTIONS = new Set(['pending', 'accepted', 'modified', 'rejected'])

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0
}

function validPageGeometry(artifact) {
  const coordinateSystem = artifact?.coordinateSystem
  return Boolean(
    coordinateSystem?.unit === 'pt' &&
    coordinateSystem?.origin === 'top-left' &&
    coordinateSystem?.xAxis === 'right' &&
    coordinateSystem?.yAxis === 'down' &&
    Number.isFinite(coordinateSystem.pageWidth) &&
    coordinateSystem.pageWidth > 0 &&
    Number.isFinite(coordinateSystem.pageHeight) &&
    coordinateSystem.pageHeight > 0,
  )
}

function validBlockGeometry(block, artifact, blockId, pdfPage) {
  const bbox = block?.bbox
  const { pageWidth, pageHeight } = artifact.coordinateSystem
  return Boolean(
    block?.id === blockId &&
    block?.pdfPage === pdfPage &&
    bbox &&
    finiteNonNegative(bbox.x) &&
    finiteNonNegative(bbox.y) &&
    Number.isFinite(bbox.width) &&
    bbox.width > 0 &&
    Number.isFinite(bbox.height) &&
    bbox.height > 0 &&
    bbox.x + bbox.width <= pageWidth + 0.01 &&
    bbox.y + bbox.height <= pageHeight + 0.01,
  )
}

export class AiCandidateOverlayService {
  constructor({ aiReviewService, textRepository }) {
    this.aiReviewService = aiReviewService
    this.textRepository = textRepository
  }

  async list(documentId, chapterId) {
    const { chapter, workspace } = await this.aiReviewService.current(documentId, chapterId)
    const candidatesByPage = new Map()

    for (const entry of workspace.candidates) {
      const { candidate } = entry
      if (
        typeof candidate.blockId !== 'string' ||
        !candidate.blockId ||
        !Number.isSafeInteger(candidate.pdfPage) ||
        candidate.pdfPage < chapter.startPdfPage ||
        candidate.pdfPage > chapter.endPdfPage
      ) continue
      const entries = candidatesByPage.get(candidate.pdfPage) ?? []
      entries.push(entry)
      candidatesByPage.set(candidate.pdfPage, entries)
    }

    const pages = await Promise.all([...candidatesByPage.keys()].map(async (pdfPage) => [
      pdfPage,
      await this.textRepository.readPage(documentId, pdfPage),
    ]))
    const artifacts = new Map(pages)
    const overlays = []

    for (const entry of workspace.candidates) {
      const { candidate, resolution } = entry
      const artifact = artifacts.get(candidate.pdfPage)
      if (!validPageGeometry(artifact) || !Array.isArray(artifact.blocks)) continue
      const block = artifact.blocks.find((value) => value?.id === candidate.blockId)
      if (!validBlockGeometry(block, artifact, candidate.blockId, candidate.pdfPage)) continue
      const resolutionStatus = SUPPORTED_RESOLUTIONS.has(resolution?.status) ? resolution.status : 'pending'
      overlays.push({
        candidateId: candidate.id,
        pdfPage: candidate.pdfPage,
        blockId: candidate.blockId,
        bbox: {
          x: block.bbox.x,
          y: block.bbox.y,
          width: block.bbox.width,
          height: block.bbox.height,
        },
        page: {
          width: artifact.coordinateSystem.pageWidth,
          height: artifact.coordinateSystem.pageHeight,
          unit: 'pt',
          origin: 'top-left',
        },
        resolutionStatus,
      })
    }

    return { overlays }
  }
}
