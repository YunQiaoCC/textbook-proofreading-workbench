import type {
  AiCandidate,
  AiCandidateEntry,
  AiCandidateOverlay,
  AiCandidateOverlayGeometry,
  AiCandidateResolutionStatus,
  AiReviewStage,
} from '../src/models/aiReview'

export function aiOverlaysVisibleForStage(stage: AiReviewStage | null | undefined): boolean
export function aiOverlayTone(resolutionStatus: AiCandidateResolutionStatus): 'pending' | 'accepted' | 'modified'
export function deriveAiCandidateOverlays(
  candidates: readonly AiCandidateEntry[],
  geometries: readonly AiCandidateOverlayGeometry[],
  stage: AiReviewStage | null | undefined,
): AiCandidateOverlay[]
export function aiOverlayPercentRect(overlay: AiCandidateOverlay): {
  left: string
  top: string
  width: string
  height: string
} | null
export function aiCandidateNavigation(candidate: Pick<AiCandidate, 'id' | 'pdfPage'>): {
  candidateId: string
  queueKey: `ai:${string}`
  pdfPage: number
}
