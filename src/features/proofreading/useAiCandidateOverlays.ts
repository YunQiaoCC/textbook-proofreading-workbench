import { computed, ref, toValue, watch, type MaybeRef } from 'vue'
import { deriveAiCandidateOverlays } from '../../../shared/aiCandidateOverlay.js'
import type { AiCandidateOverlayGeometry, AiReviewWorkspace } from '../../models/aiReview'
import { getAiCandidateOverlayGeometry } from '../../services/aiReviewApi'

export function useAiCandidateOverlays(
  documentId: MaybeRef<string | null>,
  chapterId: MaybeRef<string | null>,
  workspace: MaybeRef<AiReviewWorkspace | null>,
) {
  const geometries = ref<AiCandidateOverlayGeometry[]>([])
  const loading = ref(false)
  const error = ref('')
  const shown = ref(true)
  let generation = 0

  async function load() {
    const currentDocumentId = toValue(documentId)
    const currentChapterId = toValue(chapterId)
    const currentWorkspace = toValue(workspace)
    const requestGeneration = ++generation
    geometries.value = []
    error.value = ''
    if (!currentDocumentId || !currentChapterId || !currentWorkspace?.candidates.length) return
    loading.value = true
    try {
      const result = await getAiCandidateOverlayGeometry(currentDocumentId, currentChapterId)
      if (requestGeneration === generation) geometries.value = result.overlays
    } catch {
      if (requestGeneration === generation) error.value = 'AI 标记位置暂不可用，右侧意见仍可正常复审。'
    } finally {
      if (requestGeneration === generation) loading.value = false
    }
  }

  const candidateGeometrySignature = computed(() => toValue(workspace)?.candidates
    .map(({ candidate }) => `${candidate.id}:${candidate.pdfPage}:${candidate.blockId ?? ''}`)
    .join('|') ?? '')

  const overlays = computed(() => {
    const current = toValue(workspace)
    return deriveAiCandidateOverlays(current?.candidates ?? [], geometries.value, current?.stage)
  })

  watch(
    () => [toValue(documentId), toValue(chapterId), candidateGeometrySignature.value],
    () => { void load() },
    { immediate: true },
  )

  return { geometries, overlays, loading, error, shown, reload: load }
}
