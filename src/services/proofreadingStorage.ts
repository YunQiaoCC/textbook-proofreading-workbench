import type { Annotation } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'

export interface ProofreadingWorkspaceSnapshot {
  annotations: Annotation[]
  issues: ProofreadingIssue[]
  selectedIssueId: string | null
}

const emptyWorkspace: ProofreadingWorkspaceSnapshot = {
  annotations: [],
  issues: [],
  selectedIssueId: null,
}

function workspaceStorageKey(documentId: string) {
  return `proofreading-workspace:${encodeURIComponent(documentId)}`
}

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

export function loadProofreadingWorkspace(documentId: string): ProofreadingWorkspaceSnapshot {
  const value = readJson<Partial<ProofreadingWorkspaceSnapshot>>(workspaceStorageKey(documentId), {})
  return {
    annotations: Array.isArray(value.annotations) ? value.annotations as Annotation[] : [],
    issues: Array.isArray(value.issues) ? value.issues as ProofreadingIssue[] : [],
    selectedIssueId: typeof value.selectedIssueId === 'string' ? value.selectedIssueId : null,
  }
}

export function saveProofreadingWorkspace(documentId: string, workspace: ProofreadingWorkspaceSnapshot) {
  writeJson(workspaceStorageKey(documentId), workspace)
}

export { emptyWorkspace }
