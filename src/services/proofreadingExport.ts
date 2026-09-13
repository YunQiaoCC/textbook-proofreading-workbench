import { aiIssueTypeLabelMap, type AiCandidateEntry, type AiReviewStage } from '../models/aiReview'
import { categoryLabelMap, type ProofreadingIssue } from '../models/proofreading'

export interface FinalProofreadingRow {
  source: 'AI初校' | '人工补充'
  pdfPage: number
  printedPage?: string
  originalText: string
  issueTypeLabel: string
  suggestion: string
  reason?: string
  reviewer: string
}

const headers = ['序号', '来源', 'PDF页码', '书中页码', '原文', '问题类型', '修改建议', '修改理由', '人工复审人']

function escapeCsvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildFinalProofreadingRows(
  candidates: readonly AiCandidateEntry[],
  issues: readonly ProofreadingIssue[],
  reviewer: string,
): FinalProofreadingRow[] {
  const aiRows = candidates.flatMap<FinalProofreadingRow>((entry) => {
    if (entry.resolution.status !== 'accepted' && entry.resolution.status !== 'modified') return []
    const source = entry.resolution.status === 'modified' ? entry.resolution.modifiedResult : entry.candidate
    if (!source) return []
    return [{
      source: 'AI初校', pdfPage: source.pdfPage,
      printedPage: 'printedPage' in source ? source.printedPage : undefined,
      originalText: source.originalText, issueTypeLabel: aiIssueTypeLabelMap[source.issueType],
      suggestion: source.suggestion, reason: source.reason,
      reviewer: entry.resolution.resolvedBy ?? reviewer,
    }]
  })
  const humanRows = issues.map<FinalProofreadingRow>((issue) => ({
    source: '人工补充', pdfPage: issue.pdfPage, printedPage: issue.printedPage,
    originalText: issue.originalText, issueTypeLabel: categoryLabelMap[issue.category],
    suggestion: issue.suggestion, reason: issue.reason, reviewer: reviewer || issue.reviewer,
  }))
  return [...aiRows, ...humanRows].map((row, stableIndex) => ({ row, stableIndex }))
    .sort((left, right) => left.row.pdfPage - right.row.pdfPage || (left.row.source === right.row.source ? 0 : left.row.source === 'AI初校' ? -1 : 1) || left.stableIndex - right.stableIndex)
    .map(({ row }) => row)
}

export function exportFinalProofreadingCsv(
  stage: AiReviewStage,
  candidates: readonly AiCandidateEntry[],
  issues: readonly ProofreadingIssue[],
  reviewer: string,
) {
  if (stage !== 'completed') return false
  const rows = buildFinalProofreadingRows(candidates, issues, reviewer)
  const csvRows = rows.map((row, index) => [index + 1, row.source, row.pdfPage, row.printedPage ?? '', row.originalText, row.issueTypeLabel, row.suggestion, row.reason ?? '', row.reviewer])
  const csv = [headers, ...csvRows].map((row) => row.map(escapeCsvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a')
  link.href = url
  link.download = '法律教材最终校对表.csv'
  link.click()
  URL.revokeObjectURL(url)
  return true
}
