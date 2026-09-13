export const aiReviewStages = [
  'awaiting_ai',
  'ai_running',
  'awaiting_human_review',
  'human_review_in_progress',
  'completed',
  'ai_failed',
] as const

export type AiReviewStage = (typeof aiReviewStages)[number]
export type AiCandidateResolutionStatus = 'pending' | 'accepted' | 'modified' | 'rejected'

export const aiReviewStageLabelMap: Record<AiReviewStage, string> = {
  awaiting_ai: '待 AI 初校',
  ai_running: 'AI 初校中',
  awaiting_human_review: '待人工复审',
  human_review_in_progress: '人工复审中',
  completed: '已完成',
  ai_failed: 'AI 初校失败',
}

export const aiCandidateResolutionLabelMap: Record<AiCandidateResolutionStatus, string> = {
  pending: '待复审',
  accepted: '已接受',
  modified: '已修改',
  rejected: '已驳回',
}

export const aiIssueTypeLabelMap = {
  typo: '错别字',
  punctuation: '标点',
  wording: '表述',
  terminology_inconsistency: '术语不一致',
  legal_concept: '法律概念',
  legal_source_mismatch: '法律依据',
  law_status: '法律状态',
  article_number: '法条序号',
  effective_date: '生效时间',
  historical_context: '历史语境',
  case_claim: '案例事实',
  case_citation: '案例引用',
  data_claim: '数据',
  citation: '引注',
  cross_reference: '交叉引用',
  overstrong_claim: '表述过强',
  pedagogical_clarification: '教学澄清',
  format: '格式',
} as const

export type AiIssueType = keyof typeof aiIssueTypeLabelMap

export interface AiCandidateEvidence {
  sourceType: string
  authorityAxis: 'normative' | 'academic' | 'other'
  title: string
  issuerOrAuthor?: string
  citationOrUrl?: string
  supports: string
  publicationDate?: string
  effectiveStatus?: string
  jurisdiction?: string
  limitations?: string
}

export interface AiCandidate {
  schemaVersion: '0.1'
  id: string
  documentId: string
  chapterId: string
  pdfPage: number
  blockId?: string
  originalText: string
  issueType: AiIssueType
  ruleType: 'static' | 'verify' | 'judgement'
  severity: 'critical' | 'major' | 'minor' | 'clarification'
  extractionReliability: 'high' | 'medium' | 'low'
  verificationStatus: 'not_required' | 'unverified' | 'verified' | 'insufficient_evidence' | 'manual_check_required'
  retrievalRequired: 'must' | 'should' | 'no'
  evidence: AiCandidateEvidence[]
  judgement: 'confirmed_error' | 'likely_error' | 'ambiguous' | 'correct_but_misleading' | 'correct_but_needs_qualification'
  suggestion: string
  reason: string
  confidence: 'high' | 'medium' | 'low'
  temporalContext?: 'current' | 'historical' | 'mixed' | 'unspecified'
  disputeStatus?: 'none' | 'academic_dispute' | 'judicial_divergence' | 'unclear'
  jurisdictionScope?: string
  humanReviewNote?: string
  humanResolution: AiCandidateResolutionStatus
  correctedText?: string
}

export interface ModifiedCandidateResult {
  originalText: string
  issueType: AiIssueType
  suggestion: string
  reason?: string
  pdfPage: number
  printedPage?: string
}

export interface AiCandidateResolution {
  status: AiCandidateResolutionStatus
  resolvedBy?: string
  resolvedAt?: string
  modifiedResult?: ModifiedCandidateResult
}

export interface AiCandidateEntry {
  candidate: AiCandidate
  resolution: AiCandidateResolution
}

export interface AiReviewWorkspace {
  schemaVersion: 1
  documentId: string
  chapterId: string
  revision: number
  stage: AiReviewStage
  aiRun: {
    status: 'not_started' | 'running' | 'completed' | 'failed'
    startedAt?: string
    completedAt?: string
    failedAt?: string
    errorCode?: string
    failurePhase?: 'location_gate'
    locationFailureCategory?: 'page_not_found' | 'block_not_found'
    upstreamErrorCategory?: 'invalid_json_schema' | 'invalid_parameter' | 'context_too_long' | 'authentication' | 'rate_limit' | 'unknown_bad_request'
    upstreamErrorCode?: string
    provider?: 'deepseek'
    model?: string
    skillVersion?: string
    skillHash?: string
    coverage?: {
      totalPages: number
      readyPages: number
      suspiciousPages: number
      unavailablePages: number
      blankPages: number
      coveredTextPages: number
      complete: boolean
    }
    usage?: Record<string, unknown>
    findingCount?: number
    retrievalClaimCount?: number
    evidenceFoundCount?: number
    candidateCount?: number
  }
  humanReview: {
    status: 'not_started' | 'in_progress' | 'completed'
    reviewerName?: string
    startedAt?: string
    completedAt?: string
  }
  candidates: AiCandidateEntry[]
  createdAt: string | null
  updatedAt: string | null
}

export interface AiRuntimeStatus {
  configured: boolean
  provider: 'deepseek'
  model: string
}

export interface AiReviewSummary {
  chapterId: string
  stage: AiReviewStage
  candidateCount: number
  pendingCount: number
}
