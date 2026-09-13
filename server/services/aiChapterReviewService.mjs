import {
  candidateIssueTypes,
  validateCandidateIssue,
} from '../candidates/candidateContract.mjs'
import { AiReviewRevisionConflictError } from '../repositories/fileBackedAiReviewRepository.mjs'
import { DocumentNotFoundError } from './documentLifecycleCoordinator.mjs'
import { HttpError } from './uploadSessionService.mjs'

export const AI_REVIEW_STAGES = Object.freeze([
  'awaiting_ai',
  'ai_running',
  'awaiting_human_review',
  'human_review_in_progress',
  'completed',
  'ai_failed',
])

const RESOLUTION_STATUSES = new Set(['accepted', 'modified', 'rejected'])
const MODIFIED_RESULT_KEYS = new Set([
  'originalText',
  'issueType',
  'suggestion',
  'reason',
  'pdfPage',
  'printedPage',
])
const CANDIDATE_ISSUE_TYPES = new Set(candidateIssueTypes())
const SAFE_IDENTIFIER = /^[A-Za-z0-9-]+$/
const SAFE_ERROR_CODE = /^[a-z0-9_:-]{1,120}$/
const MAX_NAME_LENGTH = 120
const MAX_TEXT_LENGTH = 1_000_000
const MAX_CANDIDATES = 10_000

function invalid(message, code = 'invalid_ai_review') {
  throw new HttpError(400, code, message)
}

function conflict(message, code = 'invalid_ai_review_transition', details) {
  throw new HttpError(409, code, message, details)
}

function validIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
}

function assertRecord(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(message)
}

function assertExpectedRevision(workspace, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    invalid('expectedRevision must be a non-negative integer', 'invalid_ai_review_revision')
  }
  if (workspace.revision !== expectedRevision) {
    conflict(
      'AI review workspace has changed; reload the latest data',
      'ai_review_revision_conflict',
      { currentRevision: workspace.revision },
    )
  }
}

function requireStage(workspace, expectedStage, nextStage) {
  if (workspace.stage !== expectedStage) {
    conflict(`cannot transition AI review from ${workspace.stage} to ${nextStage}`)
  }
}

function normalizeReviewerName(value) {
  if (typeof value !== 'string') invalid('reviewerName must be a non-empty string', 'invalid_reviewer_name')
  const reviewerName = value.trim()
  if (!reviewerName || reviewerName.length > MAX_NAME_LENGTH) {
    invalid('reviewerName must be a non-empty string', 'invalid_reviewer_name')
  }
  return reviewerName
}

function assertReviewer(chapter, workspace, value) {
  const reviewerName = normalizeReviewerName(value)
  const responsibleReviewer = chapter.assigneeName ?? workspace.humanReview.reviewerName
  if (responsibleReviewer && reviewerName !== responsibleReviewer) {
    conflict('reviewerName must match the chapter assignee', 'ai_review_reviewer_mismatch')
  }
  return reviewerName
}

function assertText(value, field, { optional = false } = {}) {
  if (optional && value === undefined) return
  if (typeof value !== 'string' || (!optional && value.trim().length === 0) || value.length > MAX_TEXT_LENGTH) {
    invalid(`${field} must be a valid string`, 'invalid_modified_candidate')
  }
}

function normalizeModifiedResult(value, chapter) {
  assertRecord(value, 'modifiedResult must be an object')
  for (const key of Object.keys(value)) {
    if (!MODIFIED_RESULT_KEYS.has(key)) invalid(`modifiedResult contains unsupported field ${key}`, 'invalid_modified_candidate')
  }
  assertText(value.originalText, 'modifiedResult.originalText')
  assertText(value.suggestion, 'modifiedResult.suggestion')
  assertText(value.reason, 'modifiedResult.reason', { optional: true })
  assertText(value.printedPage, 'modifiedResult.printedPage', { optional: true })
  if (!CANDIDATE_ISSUE_TYPES.has(value.issueType)) {
    invalid('modifiedResult.issueType is not supported', 'invalid_modified_candidate')
  }
  if (
    !Number.isSafeInteger(value.pdfPage) ||
    value.pdfPage < chapter.startPdfPage ||
    value.pdfPage > chapter.endPdfPage
  ) {
    invalid('modifiedResult.pdfPage is outside the selected chapter range', 'invalid_modified_candidate')
  }
  return {
    originalText: value.originalText,
    issueType: value.issueType,
    suggestion: value.suggestion,
    ...(value.reason !== undefined ? { reason: value.reason } : {}),
    pdfPage: value.pdfPage,
    ...(value.printedPage !== undefined ? { printedPage: value.printedPage } : {}),
  }
}

function validateCandidateBatch(candidates, documentId, chapter) {
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) {
    invalid('candidates must be an array within the allowed limit', 'invalid_ai_candidate_batch')
  }
  const ids = new Set()
  return candidates.map((candidate, index) => {
    const errors = validateCandidateIssue(candidate)
    if (errors.length > 0) {
      invalid('AI candidate does not satisfy the v0.1 contract', 'invalid_ai_candidate')
    }
    if (candidate.documentId !== documentId) {
      invalid('AI candidate documentId does not match the review workspace', 'candidate_document_mismatch')
    }
    if (candidate.chapterId !== chapter.id) {
      invalid('AI candidate chapterId does not match the review workspace', 'candidate_chapter_mismatch')
    }
    if (candidate.pdfPage < chapter.startPdfPage || candidate.pdfPage > chapter.endPdfPage) {
      invalid('AI candidate pdfPage is outside the selected chapter range', 'candidate_outside_chapter_range')
    }
    if (ids.has(candidate.id)) invalid(`duplicate AI candidate id at index ${index}`, 'duplicate_candidate_id')
    ids.add(candidate.id)
    return {
      candidate: structuredClone(candidate),
      resolution: { status: 'pending' },
    }
  })
}

export function createEmptyAiReviewWorkspace(documentId, chapterId) {
  return {
    schemaVersion: 1,
    documentId,
    chapterId,
    revision: 0,
    stage: 'awaiting_ai',
    aiRun: { status: 'not_started' },
    humanReview: { status: 'not_started' },
    candidates: [],
    createdAt: null,
    updatedAt: null,
  }
}

export class AiChapterReviewService {
  constructor({ documentRepository, aiReviewRepository, now = () => new Date() }) {
    this.documentRepository = documentRepository
    this.aiReviewRepository = aiReviewRepository
    this.now = now
  }

  async assertChapter(documentId, chapterId) {
    if (!validIdentifier(documentId) || !(await this.documentRepository.getById(documentId))) {
      throw new HttpError(404, 'document_not_found', 'document not found')
    }
    if (!validIdentifier(chapterId)) throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    const chapter = await this.documentRepository.getChapter(documentId, chapterId)
    if (!chapter) throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    return chapter
  }

  async get(documentId, chapterId) {
    await this.assertChapter(documentId, chapterId)
    return (await this.aiReviewRepository.get(documentId, chapterId)) ??
      createEmptyAiReviewWorkspace(documentId, chapterId)
  }

  async listSummaries(documentId) {
    if (!validIdentifier(documentId) || !(await this.documentRepository.getById(documentId))) {
      throw new HttpError(404, 'document_not_found', 'document not found')
    }
    const chapters = await this.documentRepository.listChapters(documentId)
    const reviews = await Promise.all(chapters.map(async (chapter) => {
      const workspace = await this.aiReviewRepository.get(documentId, chapter.id)
      return {
        chapterId: chapter.id,
        stage: workspace?.stage ?? 'awaiting_ai',
        candidateCount: workspace?.candidates.length ?? 0,
        pendingCount: workspace?.candidates.filter(({ resolution }) => resolution.status === 'pending').length ?? 0,
      }
    }))
    return { documentId, reviews }
  }

  async current(documentId, chapterId) {
    const chapter = await this.assertChapter(documentId, chapterId)
    const workspace = (await this.aiReviewRepository.get(documentId, chapterId)) ??
      createEmptyAiReviewWorkspace(documentId, chapterId)
    return { chapter, workspace }
  }

  async save(documentId, chapterId, workspace, expectedRevision) {
    try {
      return await this.aiReviewRepository.save(documentId, chapterId, workspace, expectedRevision)
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        throw new HttpError(404, 'document_not_found', 'document not found')
      }
      if (error instanceof AiReviewRevisionConflictError) {
        conflict(
          'AI review workspace has changed; reload the latest data',
          'ai_review_revision_conflict',
          { currentRevision: error.currentRevision },
        )
      }
      throw error
    }
  }

  async startAiRun(documentId, chapterId, expectedRevision) {
    const { workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'awaiting_ai', 'ai_running')
    const startedAt = this.now().toISOString()
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'ai_running',
      aiRun: { status: 'running', startedAt },
    }, expectedRevision)
  }

  async completeAiRun(documentId, chapterId, candidates, expectedRevision, metadata = {}) {
    const { chapter, workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'ai_running', 'awaiting_human_review')
    if (
      workspace.humanReview.status !== 'not_started' ||
      workspace.candidates.some(({ resolution }) => resolution.status !== 'pending')
    ) {
      conflict('AI candidates cannot be replaced after human review activity', 'ai_review_rerun_conflict')
    }
    const validatedCandidates = validateCandidateBatch(candidates, documentId, chapter)
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'awaiting_human_review',
      aiRun: {
        status: 'completed',
        startedAt: workspace.aiRun.startedAt,
        completedAt: this.now().toISOString(),
        ...structuredClone(metadata),
      },
      candidates: validatedCandidates,
    }, expectedRevision)
  }

  async failAiRun(documentId, chapterId, errorCode, expectedRevision, metadata = {}) {
    const { workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'ai_running', 'ai_failed')
    if (typeof errorCode !== 'string' || !SAFE_ERROR_CODE.test(errorCode)) {
      invalid('errorCode must be a safe non-empty code', 'invalid_ai_error_code')
    }
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'ai_failed',
      aiRun: {
        status: 'failed',
        startedAt: workspace.aiRun.startedAt,
        failedAt: this.now().toISOString(),
        errorCode,
        ...structuredClone(metadata),
      },
    }, expectedRevision)
  }

  async retryAiRun(documentId, chapterId, expectedRevision) {
    const { workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    if (
      workspace.humanReview.status !== 'not_started' ||
      workspace.candidates.some(({ resolution }) => resolution.status !== 'pending')
    ) {
      conflict('AI rerun is blocked after human review activity', 'ai_review_rerun_conflict')
    }
    requireStage(workspace, 'ai_failed', 'ai_running')
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'ai_running',
      aiRun: { status: 'running', startedAt: this.now().toISOString() },
    }, expectedRevision)
  }

  async startHumanReview(documentId, chapterId, reviewerName, expectedRevision) {
    const { chapter, workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'awaiting_human_review', 'human_review_in_progress')
    const responsibleReviewer = assertReviewer(chapter, workspace, reviewerName)
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'human_review_in_progress',
      humanReview: {
        status: 'in_progress',
        reviewerName: responsibleReviewer,
        startedAt: this.now().toISOString(),
      },
    }, expectedRevision)
  }

  async resolveCandidate(documentId, chapterId, candidateId, resolution, expectedRevision) {
    const { chapter, workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'human_review_in_progress', 'human_review_in_progress')
    if (typeof candidateId !== 'string' || !candidateId) {
      invalid('candidateId must be a non-empty string', 'invalid_candidate_id')
    }
    assertRecord(resolution, 'resolution must be an object')
    if (!RESOLUTION_STATUSES.has(resolution.status)) {
      invalid('resolution.status is not supported', 'invalid_candidate_resolution')
    }
    const resolvedBy = assertReviewer(chapter, workspace, resolution.resolvedBy)
    let modifiedResult
    if (resolution.status === 'modified') {
      modifiedResult = normalizeModifiedResult(resolution.modifiedResult, chapter)
    } else if (resolution.modifiedResult !== undefined) {
      invalid('modifiedResult is only allowed for modified resolutions', 'invalid_candidate_resolution')
    }
    const index = workspace.candidates.findIndex(({ candidate }) => candidate.id === candidateId)
    if (index === -1) throw new HttpError(404, 'candidate_not_found', 'AI candidate not found')
    const candidates = workspace.candidates.map((entry, entryIndex) => entryIndex === index ? {
      candidate: entry.candidate,
      resolution: {
        status: resolution.status,
        resolvedBy,
        resolvedAt: this.now().toISOString(),
        ...(modifiedResult ? { modifiedResult } : {}),
      },
    } : entry)
    return this.save(documentId, chapterId, { ...workspace, candidates }, expectedRevision)
  }

  async completeHumanReview(documentId, chapterId, reviewerName, expectedRevision) {
    const { chapter, workspace } = await this.current(documentId, chapterId)
    assertExpectedRevision(workspace, expectedRevision)
    requireStage(workspace, 'human_review_in_progress', 'completed')
    const responsibleReviewer = assertReviewer(chapter, workspace, reviewerName)
    if (workspace.candidates.some(({ resolution }) => resolution.status === 'pending')) {
      conflict('all AI candidates must be resolved before completing human review', 'pending_ai_candidates')
    }
    return this.save(documentId, chapterId, {
      ...workspace,
      stage: 'completed',
      humanReview: {
        ...workspace.humanReview,
        status: 'completed',
        reviewerName: responsibleReviewer,
        completedAt: this.now().toISOString(),
      },
    }, expectedRevision)
  }
}
