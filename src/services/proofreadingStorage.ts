import type { IAnnotationStore } from 'inklayer-vue'
import type { ProofreadingIssue } from '../models/proofreading'

export interface LegacyProofreadingWorkspaceSnapshot {
  annotations: IAnnotationStore[]
  issues: ProofreadingIssue[]
  selectedIssueId: string | null
}

export type ProofreadingMigrationStatus = 'migrated' | 'skipped' | 'conflict'

export interface ProofreadingClientState {
  selectedIssueId: string | null
  serverRevision: number
  migrationStatus?: ProofreadingMigrationStatus
}

const emptyWorkspace: LegacyProofreadingWorkspaceSnapshot = {
  annotations: [],
  issues: [],
  selectedIssueId: null,
}

function encodedDocumentId(documentId: string) {
  return encodeURIComponent(documentId)
}

function legacyStorageKey(documentId: string) {
  return `proofreading-workspace:${encodedDocumentId(documentId)}`
}

function legacyBackupKey(documentId: string) {
  return `proofreading-workspace-legacy-backup:${encodedDocumentId(documentId)}`
}

function clientStorageKey(documentId: string) {
  return `proofreading-client:v2:${encodedDocumentId(documentId)}`
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

export function loadLegacyProofreadingWorkspace(documentId: string) {
  const value = readJson<Partial<LegacyProofreadingWorkspaceSnapshot> | null>(legacyStorageKey(documentId), null)
  if (!value || typeof value !== 'object') return null
  return {
    annotations: Array.isArray(value.annotations) ? value.annotations as IAnnotationStore[] : [],
    issues: Array.isArray(value.issues) ? value.issues as ProofreadingIssue[] : [],
    selectedIssueId: typeof value.selectedIssueId === 'string' ? value.selectedIssueId : null,
  }
}

export function saveLegacyProofreadingBackup(
  documentId: string,
  workspace: LegacyProofreadingWorkspaceSnapshot,
) {
  writeJson(legacyBackupKey(documentId), workspace)
}

export function loadProofreadingClientState(documentId: string) {
  const value = readJson<Partial<ProofreadingClientState> | null>(clientStorageKey(documentId), null)
  if (!value || typeof value !== 'object') return null
  const serverRevision = value.serverRevision
  if (typeof serverRevision !== 'number' || !Number.isSafeInteger(serverRevision) || serverRevision < 0) return null
  const migrationStatus = value.migrationStatus
  return {
    selectedIssueId: typeof value.selectedIssueId === 'string' ? value.selectedIssueId : null,
    serverRevision,
    ...(migrationStatus === 'migrated' || migrationStatus === 'skipped' || migrationStatus === 'conflict'
      ? { migrationStatus }
      : {}),
  }
}

export function saveProofreadingClientState(documentId: string, state: ProofreadingClientState) {
  writeJson(clientStorageKey(documentId), state)
}

export { emptyWorkspace }
