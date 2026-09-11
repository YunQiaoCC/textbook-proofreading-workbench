import {
  categoryLabelMap,
  statusLabelMap,
  type ProofreadingIssue,
} from '../models/proofreading'

const headers = ['序号', 'PDF页码', '书中页码', '原文', '问题类型', '修改建议', '修改理由', '校对人', '复核状态']

function escapeCsvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportProofreadingCsv(issues: ProofreadingIssue[]) {
  const rows = issues.map((issue, index) => [
    index + 1,
    issue.pdfPage,
    issue.printedPage ?? '',
    issue.originalText,
    categoryLabelMap[issue.category],
    issue.suggestion,
    issue.reason ?? '',
    issue.reviewer,
    statusLabelMap[issue.status],
  ])
  const csv = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = '法律教材校对表.csv'
  link.click()
  URL.revokeObjectURL(url)
}

