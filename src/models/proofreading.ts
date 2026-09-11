export const issueCategories = [
  { value: 'typo', label: '错别字' },
  { value: 'punctuation', label: '标点' },
  { value: 'wording', label: '表述' },
  { value: 'legal_concept', label: '法律概念' },
  { value: 'law_update', label: '法条更新' },
  { value: 'case_or_data', label: '案例/数据' },
  { value: 'citation', label: '引注' },
  { value: 'format', label: '格式' },
  { value: 'other', label: '其他' },
] as const

export const issueStatuses = [
  { value: 'pending', label: '待处理' },
  { value: 'confirmed', label: '已确认' },
  { value: 'revised', label: '已修改' },
  { value: 'reviewed', label: '已复核' },
] as const

export type IssueCategory = (typeof issueCategories)[number]['value']
export type IssueStatus = (typeof issueStatuses)[number]['value']

export interface ProofreadingIssue {
  id: string
  annotationId: string
  pdfPage: number
  printedPage?: string
  originalText: string
  category: IssueCategory
  suggestion: string
  reason?: string
  status: IssueStatus
  reviewer: string
  verifier?: string
  createdAt: string
  updatedAt: string
}

export type ProofreadingIssuePatch = Partial<
  Pick<
    ProofreadingIssue,
    | 'pdfPage'
    | 'printedPage'
    | 'originalText'
    | 'category'
    | 'suggestion'
    | 'reason'
    | 'status'
    | 'reviewer'
    | 'verifier'
  >
>

export const categoryLabelMap = Object.fromEntries(
  issueCategories.map((item) => [item.value, item.label]),
) as Record<IssueCategory, string>

export const statusLabelMap = Object.fromEntries(
  issueStatuses.map((item) => [item.value, item.label]),
) as Record<IssueStatus, string>

