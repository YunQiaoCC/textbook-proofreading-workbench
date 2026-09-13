import { ref, toValue, watch, type MaybeRef } from 'vue'
import type { ModifiedCandidateResult, AiReviewWorkspace } from '../../models/aiReview'
import { ApiError } from '../../services/apiClient'
import {
  completeHumanReview as completeHumanReviewRequest,
  getAiReviewWorkspace,
  resolveAiCandidate,
  startHumanReview as startHumanReviewRequest,
} from '../../services/aiReviewApi'

function readableError(value: unknown) {
  if (!(value instanceof ApiError)) return 'AI 复审数据操作失败，请稍后重试。'
  if (value.code === 'network_error') return '网络错误，请检查连接。'
  if (value.code === 'ai_review_revision_conflict') return '检测到其他窗口更新了 AI 复审结果，请重新加载。'
  if (value.code === 'ai_review_reviewer_mismatch') return '当前操作人不是本章指定的人工复审负责人。'
  if (value.code === 'pending_ai_candidates') return '仍有 AI 建议待复审，暂时不能完成本章。'
  if (value.code === 'invalid_ai_review_transition') return '当前章节阶段不允许执行此操作。'
  return value.message || 'AI 复审数据操作失败，请稍后重试。'
}

export function useAiReviewWorkspace(
  documentId: MaybeRef<string | null>,
  chapterId: MaybeRef<string | null>,
  reviewerName: MaybeRef<string | null | undefined>,
) {
  const workspace = ref<AiReviewWorkspace | null>(null)
  const loading = ref(false)
  const acting = ref(false)
  const error = ref('')
  const conflict = ref(false)
  let generation = 0

  function scope() {
    const currentDocumentId = toValue(documentId)
    const currentChapterId = toValue(chapterId)
    if (!currentDocumentId || !currentChapterId) return null
    return { documentId: currentDocumentId, chapterId: currentChapterId }
  }

  function responsibleReviewer() {
    const name = toValue(reviewerName)?.trim()
    if (!name) {
      error.value = '请先指定本章人工复审负责人'
      return null
    }
    return name
  }

  function apply(next: AiReviewWorkspace) {
    workspace.value = next
    error.value = ''
    conflict.value = false
    return next
  }

  function fail(value: unknown) {
    conflict.value = value instanceof ApiError && value.code === 'ai_review_revision_conflict'
    error.value = readableError(value)
    return null
  }

  async function load() {
    const current = scope()
    const requestGeneration = ++generation
    workspace.value = null
    error.value = ''
    conflict.value = false
    if (!current) return null
    loading.value = true
    try {
      const next = await getAiReviewWorkspace(current.documentId, current.chapterId)
      return requestGeneration === generation ? apply(next) : null
    } catch (value) {
      return requestGeneration === generation ? fail(value) : null
    } finally {
      if (requestGeneration === generation) loading.value = false
    }
  }

  async function mutate(operation: (current: { documentId: string; chapterId: string }, reviewer: string, revision: number) => Promise<AiReviewWorkspace>) {
    const current = scope()
    const reviewer = responsibleReviewer()
    if (!current || !reviewer || !workspace.value || acting.value) return null
    acting.value = true
    error.value = ''
    try {
      return apply(await operation(current, reviewer, workspace.value.revision))
    } catch (value) {
      return fail(value)
    } finally {
      acting.value = false
    }
  }

  const startHumanReview = () => mutate((current, reviewer, revision) =>
    startHumanReviewRequest(current.documentId, current.chapterId, reviewer, revision))
  const acceptCandidate = (candidateId: string) => mutate((current, reviewer, revision) =>
    resolveAiCandidate(current.documentId, current.chapterId, candidateId, { status: 'accepted', resolvedBy: reviewer }, revision))
  const rejectCandidate = (candidateId: string) => mutate((current, reviewer, revision) =>
    resolveAiCandidate(current.documentId, current.chapterId, candidateId, { status: 'rejected', resolvedBy: reviewer }, revision))
  const modifyCandidate = (candidateId: string, modifiedResult: ModifiedCandidateResult) => mutate((current, reviewer, revision) =>
    resolveAiCandidate(current.documentId, current.chapterId, candidateId, { status: 'modified', resolvedBy: reviewer, modifiedResult }, revision))
  const completeHumanReview = () => mutate((current, reviewer, revision) =>
    completeHumanReviewRequest(current.documentId, current.chapterId, reviewer, revision))

  watch(() => [toValue(documentId), toValue(chapterId)], () => { void load() }, { immediate: true })

  return { workspace, loading, acting, error, conflict, load, reload: load, startHumanReview, acceptCandidate, rejectCandidate, modifyCandidate, completeHumanReview }
}
