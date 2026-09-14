const VISIBLE_STAGES = new Set(['awaiting_human_review', 'human_review_in_progress', 'completed'])
const VISIBLE_RESOLUTIONS = new Set(['pending', 'accepted', 'modified'])

export function aiOverlaysVisibleForStage(stage) {
  return VISIBLE_STAGES.has(stage)
}

export function aiOverlayTone(resolutionStatus) {
  if (resolutionStatus === 'accepted') return 'accepted'
  if (resolutionStatus === 'modified') return 'modified'
  return 'pending'
}

export function deriveAiCandidateOverlays(candidates, geometries, stage) {
  if (!aiOverlaysVisibleForStage(stage)) return []
  const geometryByCandidate = new Map(geometries.map((geometry) => [geometry.candidateId, geometry]))
  const overlays = []
  for (const entry of candidates) {
    const { candidate, resolution } = entry
    if (!VISIBLE_RESOLUTIONS.has(resolution.status)) continue
    const geometry = geometryByCandidate.get(candidate.id)
    if (
      !geometry ||
      geometry.pdfPage !== candidate.pdfPage ||
      geometry.blockId !== candidate.blockId
    ) continue
    overlays.push({
      id: `ai-overlay:${candidate.id}`,
      candidateId: candidate.id,
      pdfPage: geometry.pdfPage,
      blockId: geometry.blockId,
      bbox: { ...geometry.bbox },
      page: { ...geometry.page },
      resolutionStatus: resolution.status,
      issueType: candidate.issueType,
      severity: candidate.severity,
      readOnly: true,
    })
  }
  return overlays
}

export function aiOverlayPercentRect(overlay) {
  const { bbox, page } = overlay
  if (
    !Number.isFinite(page?.width) || page.width <= 0 ||
    !Number.isFinite(page?.height) || page.height <= 0 ||
    !Number.isFinite(bbox?.x) || bbox.x < 0 ||
    !Number.isFinite(bbox?.y) || bbox.y < 0 ||
    !Number.isFinite(bbox?.width) || bbox.width <= 0 ||
    !Number.isFinite(bbox?.height) || bbox.height <= 0
  ) return null
  return {
    left: `${(bbox.x / page.width) * 100}%`,
    top: `${(bbox.y / page.height) * 100}%`,
    width: `${(bbox.width / page.width) * 100}%`,
    height: `${(bbox.height / page.height) * 100}%`,
  }
}

export function aiCandidateNavigation(candidate) {
  return {
    candidateId: candidate.id,
    queueKey: `ai:${candidate.id}`,
    pdfPage: candidate.pdfPage,
  }
}
