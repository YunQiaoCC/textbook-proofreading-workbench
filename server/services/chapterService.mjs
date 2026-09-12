import { randomUUID } from 'node:crypto'
import { HttpError } from './uploadSessionService.mjs'

const SAFE_IDENTIFIER = /^[A-Za-z0-9-]+$/
const CHAPTER_STATUSES = new Set(['unassigned', 'not_started', 'in_progress', 'completed'])
const MAX_TITLE_LENGTH = 300
const MAX_ASSIGNEE_LENGTH = 120
const MAX_ORDER = 1_000_000

function invalid(message, code = 'invalid_chapter') {
  throw new HttpError(400, code, message)
}

function assertSafeJson(value, depth = 0) {
  if (depth > 16) invalid('chapter data is too deeply nested')
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1)
    return
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      invalid('chapter data contains a forbidden key')
    }
    assertSafeJson(nestedValue, depth + 1)
  }
}

function assertRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('request body must be an object')
  }
  assertSafeJson(value)
}

function normalizeTitle(value) {
  if (typeof value !== 'string') invalid('title must be a non-empty string')
  const title = value.trim()
  if (!title || title.length > MAX_TITLE_LENGTH) invalid('title must be a non-empty string')
  return title
}

function normalizeAssigneeName(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') invalid('assigneeName must be a string')
  const assigneeName = value.trim()
  if (assigneeName.length > MAX_ASSIGNEE_LENGTH) invalid('assigneeName is too long')
  return assigneeName || undefined
}

function normalizeOrder(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ORDER) {
    invalid('order must be a positive safe integer')
  }
  return value
}

function normalizePage(value, field, pageCount) {
  if (!Number.isSafeInteger(value) || value < 1 || value > pageCount) {
    invalid(`${field} must be a one-based PDF page within the document`)
  }
  return value
}

function normalizeStatus(value) {
  if (!CHAPTER_STATUSES.has(value)) invalid('status is not supported', 'invalid_chapter_status')
  return value
}

function publicChapter(chapter) {
  return {
    id: chapter.id,
    documentId: chapter.documentId,
    title: chapter.title,
    order: chapter.order,
    startPdfPage: chapter.startPdfPage,
    endPdfPage: chapter.endPdfPage,
    ...(chapter.assigneeName ? { assigneeName: chapter.assigneeName } : {}),
    status: chapter.status ?? 'not_started',
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    ...(chapter.level !== undefined ? { level: chapter.level } : {}),
    ...(chapter.parentChapterId ? { parentChapterId: chapter.parentChapterId } : {}),
  }
}

function validIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value)
}

export class ChapterService {
  constructor({ documentRepository, now = () => new Date() }) {
    this.documentRepository = documentRepository
    this.now = now
  }

  async assertDocument(documentId) {
    if (!validIdentifier(documentId) || !(await this.documentRepository.getById(documentId))) {
      throw new HttpError(404, 'document_not_found', 'document not found')
    }
  }

  async assertChapter(documentId, chapterId) {
    await this.assertDocument(documentId)
    if (!validIdentifier(chapterId)) {
      throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    }
    const chapter = await this.documentRepository.getChapter(documentId, chapterId)
    if (!chapter) throw new HttpError(404, 'chapter_not_found', 'chapter not found')
    return chapter
  }

  async list(documentId) {
    await this.assertDocument(documentId)
    const chapters = await this.documentRepository.listChapters(documentId)
    return {
      documentId,
      chapters: chapters.map(publicChapter).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    }
  }

  validateChapterBody(body, document) {
    assertRecord(body)
    const title = normalizeTitle(body.title)
    const order = normalizeOrder(body.order)
    const startPdfPage = normalizePage(body.startPdfPage, 'startPdfPage', document.pageCount)
    const endPdfPage = normalizePage(body.endPdfPage, 'endPdfPage', document.pageCount)
    if (startPdfPage > endPdfPage) invalid('startPdfPage must not exceed endPdfPage')
    const status = normalizeStatus(body.status ?? 'not_started')
    const assigneeName = normalizeAssigneeName(body.assigneeName)
    return {
      title,
      order,
      startPdfPage,
      endPdfPage,
      status,
      ...(assigneeName ? { assigneeName } : {}),
      ...(typeof body.level === 'number' ? { level: body.level } : {}),
      ...(typeof body.parentChapterId === 'string' && body.parentChapterId ? { parentChapterId: body.parentChapterId } : {}),
    }
  }

  async create(documentId, body) {
    await this.assertDocument(documentId)
    const document = await this.documentRepository.getById(documentId)
    const values = this.validateChapterBody(body, document)
    const now = this.now().toISOString()
    const chapter = {
      id: `chapter-${randomUUID()}`,
      documentId,
      ...values,
      createdAt: now,
      updatedAt: now,
    }
    await this.documentRepository.saveChapter(documentId, chapter)
    return publicChapter(chapter)
  }

  async update(documentId, chapterId, body) {
    const current = await this.assertChapter(documentId, chapterId)
    const document = await this.documentRepository.getById(documentId)
    const values = this.validateChapterBody(body, document)
    const chapter = {
      ...current,
      ...values,
      id: current.id,
      documentId: current.documentId,
      createdAt: current.createdAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    }
    await this.documentRepository.saveChapter(documentId, chapter)
    return publicChapter(chapter)
  }
}

export { CHAPTER_STATUSES, publicChapter, validIdentifier }
