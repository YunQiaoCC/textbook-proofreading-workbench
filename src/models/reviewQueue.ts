import type { AiCandidateEntry } from './aiReview'
import type { ProofreadingIssue } from './proofreading'

export type ReviewQueueItem =
  | { source: 'ai'; key: `ai:${string}`; entry: AiCandidateEntry }
  | { source: 'human'; key: `human:${string}`; issue: ProofreadingIssue }

export function buildReviewQueue(
  candidates: readonly AiCandidateEntry[],
  issues: readonly ProofreadingIssue[],
): ReviewQueueItem[] {
  const items: Array<ReviewQueueItem & { stableIndex: number }> = [
    ...candidates.map((entry, stableIndex) => ({
      source: 'ai' as const,
      key: `ai:${entry.candidate.id}` as const,
      entry,
      stableIndex,
    })),
    ...issues.map((issue, stableIndex) => ({
      source: 'human' as const,
      key: `human:${issue.id}` as const,
      issue,
      stableIndex,
    })),
  ]
  return items.sort((left, right) => {
    const leftPage = left.source === 'ai' ? left.entry.candidate.pdfPage : left.issue.pdfPage
    const rightPage = right.source === 'ai' ? right.entry.candidate.pdfPage : right.issue.pdfPage
    return leftPage - rightPage || (left.source === right.source ? 0 : left.source === 'ai' ? -1 : 1) || left.stableIndex - right.stableIndex
  }).map(({ stableIndex: _stableIndex, ...item }) => item)
}
