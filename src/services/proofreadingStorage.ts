import type { Annotation } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'

const issueStorageKey = 'legal-textbook-proofreading:issues:v1'
const annotationStorageKey = 'legal-textbook-proofreading:annotations:v1'

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const rawValue = window.localStorage.getItem(key)
    return rawValue ? (JSON.parse(rawValue) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(value))
}

export function loadProofreadingIssues(): ProofreadingIssue[] {
  const value = readJson<unknown>(issueStorageKey, [])
  return Array.isArray(value) ? (value as ProofreadingIssue[]) : []
}

export function saveProofreadingIssues(issues: ProofreadingIssue[]) {
  writeJson(issueStorageKey, issues)
}

export function loadAnnotations(): Annotation[] {
  const value = readJson<unknown>(annotationStorageKey, [])
  return Array.isArray(value) ? (value as Annotation[]) : []
}

export function saveAnnotations(annotations: Annotation[]) {
  writeJson(annotationStorageKey, annotations)
}

