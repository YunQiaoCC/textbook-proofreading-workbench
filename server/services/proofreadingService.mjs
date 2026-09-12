import { HttpError } from './uploadSessionService.mjs'
import { ProofreadingRevisionConflictError } from '../repositories/fileBackedProofreadingRepository.mjs'
import { DocumentNotFoundError } from './documentLifecycleCoordinator.mjs'

export const MAX_PROOFREADING_BODY_BYTES = 8 * 1024 * 1024

const MAX_WORKSPACE_ITEMS = 10_000
const MAX_STRING_LENGTH = 1_000_000
const MAX_VALIDATION_DEPTH = 64
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const ISSUE_CATEGORIES = new Set([
  'typo',
  'punctuation',
  'wording',
  'legal_concept',
  'law_update',
  'case_or_data',
  'citation',
  'format',
  'other',
])
const ISSUE_STATUSES = new Set(['pending', 'confirmed', 'revised', 'reviewed'])

function validDocumentId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

function validChapterId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

function hasBusinessData(workspace) {
  return Boolean(workspace && (
    (Array.isArray(workspace.annotations) && workspace.annotations.length > 0) ||
    (Array.isArray(workspace.issues) && workspace.issues.length > 0)
  ))
}

function invalid(message, code = 'invalid_proofreading_workspace') {
  throw new HttpError(400, code, message)
}

function assertSafeJson(value, depth = 0) {
  if (depth > MAX_VALIDATION_DEPTH) invalid('proofreading data is too deeply nested')
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1)
    return
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) invalid('proofreading data contains a forbidden key')
    assertSafeJson(nestedValue, depth + 1)
  }
}

function assertRecord(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(message)
}

function assertString(value, field, { nonEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH || (nonEmpty && value.length === 0)) {
    invalid(`${field} must be a valid string`, 'invalid_proofreading_issue')
  }
}

function assertOptionalString(value, field) {
  if (value !== undefined) assertString(value, field)
}

function validateAnnotations(annotations) {
  if (!Array.isArray(annotations) || annotations.length > MAX_WORKSPACE_ITEMS) {
    invalid('annotations must be an array within the allowed limit')
  }
  const ids = new Set()
  for (const annotation of annotations) {
    assertRecord(annotation, 'each annotation must be an object')
    assertString(annotation.id, 'annotation.id', { nonEmpty: true })
    if (ids.has(annotation.id)) invalid('duplicate annotation id', 'duplicate_annotation_id')
    ids.add(annotation.id)
  }
  return annotations
}

function validateIssues(issues, chapter = null) {
  if (!Array.isArray(issues) || issues.length > MAX_WORKSPACE_ITEMS) {
    invalid('issues must be an array within the allowed limit')
  }
  const ids = new Set()
  for (const issue of issues) {
    assertRecord(issue, 'each issue must be an object')
    assertString(issue.id, 'issue.id', { nonEmpty: true })
    if (ids.has(issue.id)) invalid('duplicate issue id', 'duplicate_issue_id')
    ids.add(issue.id)
    assertString(issue.annotationId, 'issue.annotationId', { nonEmpty: true })
    if (!Number.isSafeInteger(issue.pdfPage) || issue.pdfPage <= 0) {
      invalid('issue.pdfPage must be a positive integer', 'invalid_proofreading_issue')
    }
    if (chapter && (issue.pdfPage < chapter.startPdfPage || issue.pdfPage > chapter.endPdfPage)) {
      invalid('issue.pdfPage is outside the selected chapter range', 'issue_outside_chapter_range')
    }
    assertOptionalString(issue.printedPage, 'issue.printedPage')
    assertString(issue.originalText, 'issue.originalText')
    if (!ISSUE_CATEGORIES.has(issue.category)) invalid('issue.category is not supported', 'invalid_category')
    assertString(issue.suggestion, 'issue.suggestion')
    assertOptionalString(issue.reason, 'issue.reason')
    if (!ISSUE_STATUSES.has(issue.status)) invalid('issue.status is not supported', 'invalid_status')
    assertString(issue.reviewer, 'issue.reviewer')
    assertOptionalString(issue.verifier, 'issue.verifier')
    assertString(issue.createdAt, 'issue.createdAt', { nonEmpty: true })
    assertString(issue.updatedAt, 'issue.updatedAt', { nonEmpty: true })
  }
  return issues
}

function validateSaveBody(body, chapter = null) {
  assertRecord(body, 'request body must be an object')
  assertSafeJson(body)
  if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) {
    invalid('baseRevision must be a non-negative integer')
  }
  return {
    baseRevision: body.baseRevision,
    annotations: validateAnnotations(body.annotations),
    issues: validateIssues(body.issues, chapter),
  }
}

function emptyWorkspace(documentId, now, chapterId = undefined) {
  const timestamp = now().toISOString()
  return {
    schemaVersion: 1,
    documentId,
    ...(chapterId ? { chapterId } : {}),
    revision: 0,
    annotations: [],
    issues: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export class ProofreadingService {
  constructor({ documentRepository, proofreadingRepository, now = () => new Date() }) {
    this.documentRepository = documentRepository
    this.proofreadingRepository = proofreadingRepository
    this.now = now
  }

  async assertDocument(documentId) {
    if (!validDocumentId(documentId) || !(await this.documentRepository.getById(documentId))) {
      throw new HttpError(404, 'document_not_found', 'document not found')
    }
  }

  async assertChapter(documentId, chapterId) {
    await this.assertDocument(documentId)
    if (!validChapterId(chapterId)) {
      throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    }
    const chapter = await this.documentRepository.getChapter(documentId, chapterId)
    if (!chapter) throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    return chapter
  }

  // Legacy/document-scope compatibility API. Do not share its revision with chapters.
  async get(documentId) {
    await this.assertDocument(documentId)
    return (await this.proofreadingRepository.get(documentId)) ?? emptyWorkspace(documentId, this.now)
  }

  // Legacy/document-scope compatibility API. Do not split or auto-migrate here.
  async save(documentId, body) {
    await this.assertDocument(documentId)
    const payload = validateSaveBody(body)
    try {
      return await this.proofreadingRepository.save(documentId, payload, payload.baseRevision)
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        throw new HttpError(404, 'document_not_found', 'document not found')
      }
      if (error instanceof ProofreadingRevisionConflictError) {
        throw new HttpError(
          409,
          'proofreading_revision_conflict',
          'proofreading workspace has changed; reload the latest data',
          { currentRevision: error.currentRevision },
        )
      }
      throw error
    }
  }

  async getChapter(documentId, chapterId) {
    await this.assertChapter(documentId, chapterId)
    return (await this.proofreadingRepository.getChapter(documentId, chapterId)) ??
      emptyWorkspace(documentId, this.now, chapterId)
  }

  async saveChapter(documentId, chapterId, body) {
    const chapter = await this.assertChapter(documentId, chapterId)
    const payload = validateSaveBody(body, chapter)
    try {
      return await this.proofreadingRepository.saveChapter(
        documentId,
        chapterId,
        payload,
        payload.baseRevision,
      )
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        throw new HttpError(404, 'document_not_found', 'document not found')
      }
      if (error instanceof ProofreadingRevisionConflictError) {
        throw new HttpError(
          409,
          'proofreading_revision_conflict',
          'chapter proofreading workspace has changed; reload the latest data',
          { currentRevision: error.currentRevision },
        )
      }
      throw error
    }
  }

  /**
   * Explicit, non-destructive compatibility helper. It copies only issues
   * whose PDF page belongs to exactly one chapter and never deletes legacy
   * document-level data. It is intentionally not exposed as an HTTP route.
   */
  async migrateLegacyToChapters(documentId) {
    await this.assertDocument(documentId)
    const legacyWorkspace = await this.proofreadingRepository.get(documentId)
    if (!hasBusinessData(legacyWorkspace)) {
      return {
        status: 'empty',
        documentId,
        migratedIssueIds: [],
        skipped: [],
      }
    }

    const chapters = await this.documentRepository.listChapters(documentId)
    const chapterWorkspaces = await Promise.all(
      chapters.map(async (chapter) => ({
        chapter,
        workspace: await this.proofreadingRepository.getChapter(documentId, chapter.id),
      })),
    )
    if (chapterWorkspaces.some(({ workspace }) => hasBusinessData(workspace))) {
      return {
        status: 'blocked',
        reason: 'chapter_workspaces_not_empty',
        documentId,
        migratedIssueIds: [],
        skipped: [],
      }
    }

    const groups = new Map()
    const skipped = []
    const legacyIssues = Array.isArray(legacyWorkspace.issues) ? legacyWorkspace.issues : []
    for (const issue of legacyIssues) {
      const matches = chapters.filter((chapter) =>
        issue.pdfPage >= chapter.startPdfPage && issue.pdfPage <= chapter.endPdfPage,
      )
      if (matches.length !== 1) {
        skipped.push({
          issueId: issue.id,
          pdfPage: issue.pdfPage,
          reason: matches.length === 0 ? 'no_matching_chapter' : 'ambiguous_chapter_range',
        })
        continue
      }
      const chapter = matches[0]
      const group = groups.get(chapter.id) ?? { chapter, issues: [] }
      group.issues.push(issue)
      groups.set(chapter.id, group)
    }

    const migratedIssueIds = []
    for (const { chapter, issues } of groups.values()) {
      const annotationIds = new Set(issues.map((issue) => issue.annotationId))
      const annotations = (Array.isArray(legacyWorkspace.annotations) ? legacyWorkspace.annotations : [])
        .filter((annotation) => annotationIds.has(annotation.id))
      await this.proofreadingRepository.saveChapter(
        documentId,
        chapter.id,
        { annotations, issues },
        0,
      )
      migratedIssueIds.push(...issues.map((issue) => issue.id))
    }

    return {
      status: skipped.length ? 'migrated_with_skips' : 'migrated',
      documentId,
      migratedIssueIds,
      skipped,
    }
  }
}
