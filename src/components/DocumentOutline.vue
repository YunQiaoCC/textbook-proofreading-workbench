<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick, watch } from 'vue'
import type { ApiDocument, ApiChapter, ChapterInput } from '../services/documentApi'
import type { DocumentTextJob } from '../models/document'
import { aiReviewStageLabelMap, type AiReviewStage, type AiReviewSummary } from '../models/aiReview'

const props = defineProps<{
  documents: readonly ApiDocument[]
  selectedDocumentId: string | null
  chapters: readonly ApiChapter[]
  selectedChapterId: string | null
  loading: boolean
  chapterLoading: boolean
  error: string
  chapterError: string
  collapsed: boolean
  deletingDocumentId: string | null
  deletingChapterId: string | null
  deleteError: string
  textSummary: DocumentTextJob | null
  textError: string
  aiReviews: readonly AiReviewSummary[]
}>()

const emit = defineEmits<{
  select: [documentId: string]
  selectChapter: [chapterId: string]
  createChapter: [payload: ChapterInput, onSuccess: () => void]
  updateChapter: [chapterId: string, payload: ChapterInput, onSuccess: () => void]
  deleteDocument: [documentId: string]
  deleteChapter: [chapter: ApiChapter]
  extractText: []
}>()

const selectedDocument = computed(() =>
  props.documents.find((document) => document.id === props.selectedDocumentId) ?? null,
)

const documentStatusLabels = {
  uploaded: '已上传',
  inspecting: '检查中',
  ready: '可校对',
  failed: '检查失败',
  registered: '已登记',
  processing: '处理中',
} as const

const formOpen = ref(false)
const formSubmitting = ref(false)
const deleteTarget = ref<ApiDocument | null>(null)
const drawerRef = ref<HTMLElement | null>(null)
const editingChapterId = ref<string | null>(null)
const form = reactive<ChapterInput>({
  title: '', order: 1, startPdfPage: 1, endPdfPage: 1, assigneeName: '', status: 'not_started',
})

function chapterReviewStage(chapterId: string): AiReviewStage {
  return props.aiReviews.find((review) => review.chapterId === chapterId)?.stage ?? 'awaiting_ai'
}

function documentStatusLabel(status: ApiDocument['processingStatus']) {
  return documentStatusLabels[status] ?? status
}

function resetForm() {
  form.title = ''
  form.order = props.chapters.length + 1
  form.startPdfPage = 1
  form.endPdfPage = Math.max(1, selectedDocument.value?.pageCount ?? 1)
  form.assigneeName = ''
  form.status = 'not_started'
}

function openCreate() {
  editingChapterId.value = null
  resetForm()
  formSubmitting.value = false
  formOpen.value = true
  void nextTick(() => drawerRef.value?.querySelector<HTMLInputElement>('input')?.focus())
}

function openEdit(chapter: ApiChapter) {
  editingChapterId.value = chapter.id
  form.title = chapter.title
  form.order = chapter.order
  form.startPdfPage = chapter.startPdfPage
  form.endPdfPage = chapter.endPdfPage
  form.assigneeName = chapter.assigneeName ?? ''
  form.status = chapter.status
  formSubmitting.value = false
  formOpen.value = true
  void nextTick(() => drawerRef.value?.querySelector<HTMLInputElement>('input')?.focus())
}

function closeForm() {
  if (formSubmitting.value) return
  formOpen.value = false
  editingChapterId.value = null
}

function submitForm() {
  if (!selectedDocument.value || !form.title.trim() || formSubmitting.value) return
  const payload: ChapterInput = {
    title: form.title.trim(),
    order: Number(form.order),
    startPdfPage: Number(form.startPdfPage),
    endPdfPage: Number(form.endPdfPage),
    assigneeName: form.assigneeName?.trim() || undefined,
    status: form.status,
  }
  formSubmitting.value = true
  const onSuccess = () => {
    formSubmitting.value = false
    formOpen.value = false
    editingChapterId.value = null
  }
  if (editingChapterId.value) emit('updateChapter', editingChapterId.value, payload, onSuccess)
  else emit('createChapter', payload, onSuccess)
}

function openDelete(document: ApiDocument) {
  if (props.deletingDocumentId) return
  deleteTarget.value = document
}

function closeDelete() {
  if (props.deletingDocumentId) return
  deleteTarget.value = null
}

function submitDelete() {
  if (!deleteTarget.value || props.deletingDocumentId) return
  emit('deleteDocument', deleteTarget.value.id)
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (deleteTarget.value && event.key === 'Escape' && !props.deletingDocumentId) {
    event.preventDefault()
    closeDelete()
    return
  }
  if (formOpen.value && event.key === 'Escape' && !formSubmitting.value) {
    event.preventDefault()
    closeForm()
  }
}

watch(() => props.documents, (documents) => {
  if (deleteTarget.value && !documents.some((document) => document.id === deleteTarget.value?.id) && !props.deletingDocumentId) {
    closeDelete()
  }
})

watch(() => props.deletingDocumentId, (documentId) => {
  if (!documentId && deleteTarget.value && !props.documents.some((document) => document.id === deleteTarget.value?.id)) {
    closeDelete()
  }
})

watch(() => props.chapterError, (error) => {
  if (error) formSubmitting.value = false
})

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

</script>

<template>
  <aside class="outline-panel" :class="{ collapsed }">
    <div class="outline-heading">
      <div><span class="panel-kicker">DOCUMENT</span><h2>教材目录</h2></div>
      <span class="document-count">{{ documents.length }}</span>
    </div>

    <div v-if="documents.length" class="document-list" aria-label="文档列表">
      <div v-for="document in documents" :key="document.id" class="document-item">
        <button
          class="document-option"
          :class="{ active: selectedDocumentId === document.id }"
          type="button"
          :disabled="Boolean(deletingDocumentId)"
          @click="emit('select', document.id)"
        >
          <strong>{{ document.title }}</strong>
          <span>{{ document.pageCount }} &#39029; &#183; {{ documentStatusLabel(document.processingStatus) }}</span>
        </button>
        <button
          class="document-delete"
          type="button"
          :disabled="Boolean(deletingDocumentId)"
          aria-label="&#21024;&#38500;&#25945;&#26448;"
          title="&#21024;&#38500;&#25945;&#26448;"
          @click.stop="openDelete(document)"
        >&#8943;</button>
      </div>
    </div>
    <div v-else class="empty-document">
      <strong>尚未上传教材</strong>
      <span>选择一个 PDF 开始校对</span>
    </div>

    <div v-if="selectedDocument" class="doc-card">
      <div class="doc-card-icon">§</div>
      <div class="doc-card-copy">
        <strong>{{ selectedDocument.title }}</strong>
        <span>{{ selectedDocument.pageCount }} 页 · {{ documentStatusLabel(selectedDocument.processingStatus) }}</span>
        <span v-if="textSummary?.status === 'processing' || textSummary?.status === 'queued'">文本解析中 {{ textSummary.processedPages }} / {{ textSummary.totalPages }}</span>
        <span v-else-if="textSummary?.status === 'completed'">文本已准备 · 可直接使用 {{ textSummary.nativeReadyPages ?? textSummary.nativeTextPages }} 页 · 需人工检查 {{ textSummary.nativeSuspiciousPages ?? 0 }} 页 · 需 OCR {{ textSummary.ocrRequiredPages }} 页</span>
        <span v-else-if="textSummary?.status === 'failed'" class="text-status-error">文本解析失败 · {{ textSummary.failedPages }} 页</span>
        <span v-else-if="textError" class="text-status-error">{{ textError }}</span>
        <button v-if="textSummary?.status === 'failed'" class="text-retry" type="button" @click="emit('extractText')">重新解析</button>
      </div>
    </div>

    <div class="chapter-label">
      <span>章节</span>
      <span class="chapter-count">{{ selectedDocument ? chapters.length : '—' }}</span>
    </div>

    <template v-if="selectedDocument">
      <div v-if="chapters.length" class="chapter-list" aria-label="章节列表">
        <div v-for="chapter in chapters" :key="chapter.id" class="chapter-item">
          <button
            class="chapter-row"
            :class="{ active: selectedChapterId === chapter.id }"
            type="button"
            @click="emit('selectChapter', chapter.id)"
          >
            <span class="chapter-status" :class="`status-${chapterReviewStage(chapter.id)}`" />
            <span class="chapter-copy">
              <strong>{{ chapter.title }}</strong>
              <span>PDF {{ chapter.startPdfPage }}–{{ chapter.endPdfPage }} · {{ chapter.assigneeName ? `负责人：${chapter.assigneeName}` : '未指定负责人' }}</span>
            </span>
            <span class="chapter-progress">{{ aiReviewStageLabelMap[chapterReviewStage(chapter.id)] }}</span>
          </button>
          <div class="chapter-actions">
            <button class="chapter-edit" type="button" aria-label="编辑章节" :disabled="Boolean(deletingChapterId)" @click.stop="openEdit(chapter)">编辑</button>
            <button class="chapter-delete" type="button" aria-label="删除章节" :disabled="Boolean(deletingChapterId)" @click.stop="emit('deleteChapter', chapter)">{{ deletingChapterId === chapter.id ? '删除中…' : '删除' }}</button>
          </div>
        </div>
      </div>
      <div v-else class="chapter-empty">章节信息待建立</div>

      <button class="chapter-setup-button" type="button" @click="openCreate">{{ chapters.length ? '新增章节' : '建立章节' }}</button>

      <div v-if="formOpen" ref="drawerRef" class="chapter-drawer" role="dialog" aria-label="章节设置" tabindex="-1">
        <div class="chapter-drawer-header">
          <div>
            <span class="chapter-drawer-kicker">CHAPTER SETUP</span>
            <h3>{{ editingChapterId ? '编辑章节' : '建立章节' }}</h3>
          </div>
          <button class="chapter-drawer-close" type="button" aria-label="关闭章节设置" :disabled="formSubmitting" @click="closeForm">×</button>
        </div>
        <form class="chapter-form" @submit.prevent="submitForm">
          <div class="chapter-form-body">
            <p class="chapter-form-help">边看 PDF 边填写页码，章节会按 PDF 页范围分别保存。</p>
            <label>标题<input v-model="form.title" required maxlength="300" placeholder="如：第一章 总则" :disabled="formSubmitting" /></label>
            <div class="chapter-form-grid">
              <label>顺序<input v-model.number="form.order" min="1" type="number" :disabled="formSubmitting" /></label>
              <label>负责人<input v-model="form.assigneeName" maxlength="120" placeholder="可选" :disabled="formSubmitting" /></label>
              <label>起始 PDF 页<input v-model.number="form.startPdfPage" :max="selectedDocument.pageCount" min="1" type="number" :disabled="formSubmitting" /></label>
              <label>结束 PDF 页<input v-model.number="form.endPdfPage" :max="selectedDocument.pageCount" min="1" type="number" :disabled="formSubmitting" /></label>
            </div>
            <p v-if="chapterError" class="chapter-form-error" role="alert">{{ chapterError }}</p>
          </div>
          <div class="chapter-form-actions">
            <button type="button" :disabled="formSubmitting" @click="closeForm">取消</button>
            <button class="primary" type="submit" :disabled="formSubmitting || chapterLoading">{{ formSubmitting ? '保存中…' : '保存' }}</button>
          </div>
        </form>
      </div>
    </template>
    <div v-else class="chapter-empty">章节信息待建立</div>

    <p v-if="loading || chapterLoading" class="outline-note">正在加载{{ chapterLoading ? '章节…' : '文档…' }}</p>
    <p v-if="error || chapterError" class="outline-error" role="alert">{{ error || chapterError }}</p>

    <Teleport to="body">
      <div v-if="deleteTarget" class="document-delete-backdrop">
        <section class="document-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="document-delete-title">
          <h2 id="document-delete-title">删除教材？</h2>
          <p class="document-delete-target">《{{ deleteTarget.title }}》</p>
          <p>&#23558;&#21024;&#38500;&#35813;&#25945;&#26448;&#12289;&#31456;&#33410;&#21450;&#26657;&#23545;&#24847;&#35265;&#12290;&#27492;&#25805;&#20316;&#19981;&#33021;&#20174;&#24037;&#20316;&#21488;&#25764;&#38144;&#12290;</p>
          <p>&#21382;&#21490;&#22791;&#20221;&#21487;&#33021;&#26242;&#26102;&#20445;&#30041;&#21103;&#26412;&#12290;</p>
          <p v-if="deleteError" class="document-delete-error" role="alert">{{ deleteError }}</p>
          <div class="document-delete-actions">
            <button type="button" :disabled="Boolean(deletingDocumentId)" @click="closeDelete">&#21462;&#28040;</button>
            <button class="danger" type="button" :disabled="Boolean(deletingDocumentId)" @click="submitDelete">{{ deletingDocumentId ? '&#21024;&#38500;&#20013;&#8230;' : '&#30830;&#35748;&#21024;&#38500;' }}</button>
          </div>
        </section>
      </div>
    </Teleport>
  </aside>
</template>

<style scoped>
.outline-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; padding: 14px 12px 12px; background: #f8f9fb; border-right: 1px solid #dce1e9; }
.outline-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 7px 11px; }
.panel-kicker { color: #99a2b2; font-size: 9px; font-weight: 700; letter-spacing: .14em; }
h2 { margin: 4px 0 0; color: #253047; font-size: 17px; }
.document-count, .chapter-count { display: grid; min-width: 21px; height: 18px; padding: 0 5px; place-items: center; color: #728096; font-size: 9px; background: #e8edf4; border-radius: 9px; }
.document-list { display: flex; flex-direction: column; gap: 4px; max-height: 178px; overflow-y: auto; }
.document-option { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 8px 9px; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 7px; }
.document-option:hover, .document-option.active { background: #e8eef6; border-color: #d5dfec; }
.document-option.active { box-shadow: inset 3px 0 #55749d; }
.document-option strong { overflow: hidden; color: #3d4b64; font-size: 10px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.document-option span { color: #98a3b3; font-size: 9px; }
.empty-document { display: flex; flex-direction: column; gap: 5px; padding: 18px 8px; color: #9da7b5; text-align: center; }
.empty-document strong { color: #6e7c91; font-size: 11px; }
.empty-document span { font-size: 9px; }
.doc-card { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; padding: 9px; background: #eef1f6; border: 1px solid #e0e5ec; border-radius: 8px; }
.doc-card-icon { display: grid; width: 27px; height: 31px; place-items: center; color: #4d6d9f; font-size: 18px; background: #dce6f5; border-radius: 5px; }
.doc-card-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.doc-card-copy strong { overflow: hidden; color: #354159; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.doc-card-copy span { margin-top: 3px; color: #929cad; font-size: 10px; }
.doc-card-copy .text-status-error { color: #a44e4e; }
.text-retry { align-self: flex-start; margin-top: 5px; padding: 3px 6px; color: #49698f; font-size: 9px; background: #fff; border: 1px solid #cfd9e7; border-radius: 4px; }
.chapter-label { display: flex; justify-content: space-between; padding: 0 8px 8px; color: #8791a2; font-size: 10px; font-weight: 700; }
.chapter-list { display: flex; flex: 1; flex-direction: column; gap: 3px; min-height: 0; overflow-y: auto; padding-right: 2px; }
.chapter-item { display: flex; align-items: center; }
.chapter-row { position: relative; display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 10px 5px 10px 8px; text-align: left; background: transparent; border: 0; border-radius: 7px; }
.chapter-row:hover, .chapter-row.active { background: #e8edf5; }
.chapter-row.active::before { position: absolute; top: 8px; bottom: 8px; left: 0; width: 3px; background: #4e6f9e; border-radius: 3px; content: ""; }
.chapter-status { width: 7px; height: 7px; flex: 0 0 auto; background: #c7ced8; border: 1px solid #b7c0cc; border-radius: 50%; }
.chapter-status.status-ai_running,.chapter-status.status-human_review_in_progress { background: #6e9fc1; border-color: #5b89ab; }
.chapter-status.status-awaiting_human_review { background: #c7a466; border-color: #b58e4d; }
.chapter-status.status-completed { background: #69a184; border-color: #568b70; }
.chapter-status.status-ai_failed { background: #b87575; border-color: #a35e5e; }
.chapter-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.chapter-copy strong { overflow: hidden; color: #445069; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chapter-row.active .chapter-copy strong { color: #28456e; }
.chapter-copy span, .chapter-progress { margin-top: 3px; color: #9aa4b3; font-size: 9px; }
.chapter-progress { white-space: nowrap; }
.chapter-actions { display: flex; flex-direction: column; align-self: stretch; justify-content: center; gap: 1px; }
.chapter-edit, .chapter-delete { padding: 2px 3px; color: #8e9aab; font-size: 9px; background: transparent; border: 0; opacity: 0; }
.chapter-item:hover .chapter-edit, .chapter-item:hover .chapter-delete, .chapter-edit:focus, .chapter-delete:focus { opacity: 1; }
.chapter-edit:hover { color: #49698f; }
.chapter-delete:hover { color: #8f5c64; }
.chapter-edit:disabled, .chapter-delete:disabled { cursor: wait; opacity: .35; }
.chapter-empty { padding: 15px 8px; color: #a1aab7; font-size: 10px; text-align: center; background: #f3f5f8; border: 1px dashed #dce2ea; border-radius: 6px; }
.chapter-setup-button { width: 100%; margin-top: 8px; padding: 7px; color: #49698f; font-size: 10px; background: #f1f5fa; border: 1px solid #d8e2ee; border-radius: 6px; }
.chapter-setup-button:hover { background: #e7eef8; }
.chapter-drawer { position: fixed; top: 78px; left: 16px; z-index: 30; display: flex; flex-direction: column; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 94px); overflow: hidden; background: #fff; border: 1px solid #cfd9e7; border-radius: 12px; box-shadow: 0 20px 55px rgba(25, 37, 57, .24); }
.chapter-drawer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 18px 20px 14px; color: #2e3d56; background: #f7f9fc; border-bottom: 1px solid #e3e8ef; }
.chapter-drawer-kicker { color: #8b98aa; font-size: 9px; font-weight: 700; letter-spacing: .14em; }
.chapter-drawer h3 { margin: 5px 0 0; font-size: 17px; }
.chapter-drawer-close { display: grid; width: 30px; height: 30px; place-items: center; padding: 0; color: #718098; font-size: 22px; line-height: 1; background: transparent; border: 1px solid transparent; border-radius: 6px; }
.chapter-drawer-close:hover { color: #30496d; background: #e9eef6; }
.chapter-form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.chapter-form-body { display: flex; flex-direction: column; gap: 13px; min-height: 0; overflow-y: auto; padding: 18px 20px 22px; }
.chapter-form-help { margin: 0; color: #78869b; font-size: 11px; line-height: 1.5; }
.chapter-form label { display: flex; flex-direction: column; gap: 6px; color: #68788f; font-size: 11px; font-weight: 600; }
.chapter-form input, .chapter-form select { width: 100%; padding: 9px 10px; color: #33425b; font-size: 13px; background: #fbfcfd; border: 1px solid #d6dfe9; border-radius: 6px; }
.chapter-form input:focus, .chapter-form select:focus { border-color: #6d8fb9; outline: 2px solid rgba(109, 143, 185, .18); }
.chapter-form input:disabled, .chapter-form select:disabled { cursor: wait; background: #f1f4f8; }
.chapter-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 13px 10px; }
.chapter-form-error { margin: 0; padding: 10px 11px; color: #a44e4e; font-size: 11px; line-height: 1.5; background: #fff2f0; border: 1px solid #f0c9c3; border-radius: 6px; }
.chapter-form-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: auto; padding: 13px 20px 16px; background: #fff; border-top: 1px solid #e3e8ef; }
.chapter-form-actions button { min-width: 76px; padding: 9px 13px; color: #66758a; font-size: 12px; background: #fff; border: 1px solid #d6dfe9; border-radius: 6px; }
.chapter-form-actions button:disabled, .chapter-drawer-close:disabled { cursor: wait; opacity: .6; }
.chapter-form-actions button:hover:not(:disabled) { background: #f3f6fa; }
.chapter-form-actions .primary { color: #fff; background: #4e6f9d; border-color: #4e6f9d; }
.chapter-form-actions .primary:hover:not(:disabled) { background: #3f608d; }
.outline-note { margin: 9px 7px 0; color: #71819a; font-size: 9px; }
.outline-error { margin: 7px 7px 0; color: #a55555; font-size: 9px; line-height: 1.4; }

.outline-panel.collapsed > :not(.chapter-drawer) { opacity: 0; visibility: hidden; pointer-events: none; }
.document-item { display: flex; align-items: stretch; min-width: 0; }
.document-item .document-option { flex: 1; min-width: 0; }
.document-delete { width: 24px; padding: 0; color: #a7afbb; font-size: 16px; line-height: 1; background: transparent; border: 0; border-radius: 5px; opacity: 0; }
.document-item:hover .document-delete, .document-delete:focus { opacity: 1; }
.document-delete:hover { color: #8f5c64; background: #fff3f4; }
.document-delete:disabled { cursor: wait; opacity: .35; }
.document-delete-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: rgba(23, 32, 51, .3); }
.document-delete-dialog { width: min(410px, calc(100vw - 40px)); padding: 21px; color: #68758b; background: #fff; border: 1px solid #dfe4eb; border-radius: 11px; box-shadow: 0 18px 52px rgba(23, 32, 51, .22); }
.document-delete-dialog h2 { margin: 0 0 12px; font-size: 16px; }
.document-delete-dialog p { margin: 7px 0; font-size: 11px; line-height: 1.55; }
.document-delete-target { color: #2f405e; font-size: 13px !important; font-weight: 700; }
.document-delete-label { display: flex; flex-direction: column; gap: 6px; margin-top: 15px; color: #68758b; font-size: 10px; font-weight: 600; }
.document-delete-label input { width: 100%; padding: 9px 10px; color: #33425b; font-size: 12px; background: #fbfcfd; border: 1px solid #d6dfe9; border-radius: 6px; }
.document-delete-label input:focus { border-color: #6d8fb9; outline: 2px solid rgba(109, 143, 185, .18); }
.document-delete-error { padding: 8px 9px; color: #a44e4e; background: #fff2f0; border: 1px solid #f0c9c3; border-radius: 5px; }
.document-delete-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
.document-delete-actions button { min-width: 76px; padding: 8px 12px; color: #66758a; font-size: 11px; background: #fff; border: 1px solid #d6dfe9; border-radius: 6px; }
.document-delete-actions button:disabled { cursor: wait; opacity: .55; }
.document-delete-actions .danger { color: #fff; background: #8a5963; border-color: #8a5963; }
</style>
