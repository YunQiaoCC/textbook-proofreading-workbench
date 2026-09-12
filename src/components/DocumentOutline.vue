<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { ApiDocument, ApiChapter, ChapterInput } from '../services/documentApi'

const props = defineProps<{
  documents: readonly ApiDocument[]
  selectedDocumentId: string | null
  chapters: readonly ApiChapter[]
  selectedChapterId: string | null
  loading: boolean
  chapterLoading: boolean
  error: string
  chapterError: string
}>()

const emit = defineEmits<{
  select: [documentId: string]
  selectChapter: [chapterId: string]
  createChapter: [payload: ChapterInput]
  updateChapter: [chapterId: string, payload: ChapterInput]
}>()

const selectedDocument = computed(() =>
  props.documents.find((document) => document.id === props.selectedDocumentId) ?? null,
)

const statusLabels = {
  unassigned: '未分配',
  not_started: '未开始',
  in_progress: '进行中',
  completed: '已完成',
} as const

const documentStatusLabels = {
  uploaded: '已上传',
  inspecting: '检查中',
  ready: '可校对',
  failed: '检查失败',
  registered: '已登记',
  processing: '处理中',
} as const

const statusOptions = Object.entries(statusLabels) as Array<[ApiChapter['status'], string]>
const formOpen = ref(false)
const editingChapterId = ref<string | null>(null)
const form = reactive<ChapterInput>({
  title: '', order: 1, startPdfPage: 1, endPdfPage: 1, assigneeName: '', status: 'not_started',
})

function statusLabel(status: ApiChapter['status']) {
  return statusLabels[status] ?? status
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
  formOpen.value = true
}

function openEdit(chapter: ApiChapter) {
  editingChapterId.value = chapter.id
  form.title = chapter.title
  form.order = chapter.order
  form.startPdfPage = chapter.startPdfPage
  form.endPdfPage = chapter.endPdfPage
  form.assigneeName = chapter.assigneeName ?? ''
  form.status = chapter.status
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
  editingChapterId.value = null
}

function submitForm() {
  if (!selectedDocument.value || !form.title.trim()) return
  const payload: ChapterInput = {
    title: form.title.trim(),
    order: Number(form.order),
    startPdfPage: Number(form.startPdfPage),
    endPdfPage: Number(form.endPdfPage),
    assigneeName: form.assigneeName?.trim() || undefined,
    status: form.status,
  }
  if (editingChapterId.value) emit('updateChapter', editingChapterId.value, payload)
  else emit('createChapter', payload)
  closeForm()
}

</script>

<template>
  <aside class="outline-panel">
    <div class="outline-heading">
      <div><span class="panel-kicker">DOCUMENT</span><h2>教材目录</h2></div>
      <span class="document-count">{{ documents.length }}</span>
    </div>

    <div v-if="documents.length" class="document-list" aria-label="文档列表">
      <button
        v-for="document in documents"
        :key="document.id"
        class="document-option"
        :class="{ active: selectedDocumentId === document.id }"
        type="button"
        @click="emit('select', document.id)"
      >
        <strong>{{ document.title }}</strong>
        <span>{{ document.pageCount }} 页 · {{ documentStatusLabel(document.processingStatus) }}</span>
      </button>
    </div>
    <div v-else class="empty-document">
      <strong>尚未上传教材</strong>
      <span>选择一个 PDF 开始校对</span>
    </div>

    <div v-if="selectedDocument" class="doc-card">
      <div class="doc-card-icon">§</div>
      <div class="doc-card-copy"><strong>{{ selectedDocument.title }}</strong><span>{{ selectedDocument.pageCount }} 页 · {{ documentStatusLabel(selectedDocument.processingStatus) }}</span></div>
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
            <span class="chapter-status" :class="`status-${chapter.status}`" />
            <span class="chapter-copy">
              <strong>{{ chapter.title }}</strong>
              <span>PDF {{ chapter.startPdfPage }}–{{ chapter.endPdfPage }} · {{ chapter.assigneeName ? `负责人：${chapter.assigneeName}` : '未指定负责人' }}</span>
            </span>
            <span class="chapter-progress">{{ statusLabel(chapter.status) }}</span>
          </button>
          <button class="chapter-edit" type="button" aria-label="编辑章节" @click.stop="openEdit(chapter)">编辑</button>
        </div>
      </div>
      <div v-else class="chapter-empty">章节信息待建立</div>

      <button class="chapter-setup-button" type="button" @click="openCreate">{{ chapters.length ? '新增章节' : '建立章节' }}</button>

      <form v-if="formOpen" class="chapter-form" @submit.prevent="submitForm">
        <div class="chapter-form-heading">{{ editingChapterId ? '编辑章节' : '建立章节' }}</div>
        <label>标题<input v-model="form.title" required maxlength="300" placeholder="如：第一章 总则" /></label>
        <div class="chapter-form-grid">
          <label>顺序<input v-model.number="form.order" min="1" type="number" /></label>
          <label>负责人<input v-model="form.assigneeName" maxlength="120" placeholder="可选" /></label>
          <label>起始 PDF 页<input v-model.number="form.startPdfPage" :max="selectedDocument.pageCount" min="1" type="number" /></label>
          <label>结束 PDF 页<input v-model.number="form.endPdfPage" :max="selectedDocument.pageCount" min="1" type="number" /></label>
        </div>
        <label>状态<select v-model="form.status"><option v-for="[value, label] in statusOptions" :key="value" :value="value">{{ label }}</option></select></label>
        <div class="chapter-form-actions"><button type="button" @click="closeForm">取消</button><button class="primary" type="submit">保存</button></div>
      </form>
    </template>
    <div v-else class="chapter-empty">章节信息待建立</div>

    <p v-if="loading || chapterLoading" class="outline-note">正在加载{{ chapterLoading ? '章节…' : '文档…' }}</p>
    <p v-if="error || chapterError" class="outline-error" role="alert">{{ error || chapterError }}</p>

    <div class="outline-footer">
      <div class="team-title"><span class="team-icon">♧</span> 校对协作</div>
      <div class="team-avatars"><span class="mini-avatar gold">校</span><span class="mini-avatar blue">复</span><span class="mini-avatar gray">+2</span></div>
      <span class="team-note">负责人仅为分工信息</span>
    </div>
  </aside>
</template>

<style scoped>
.outline-panel { display: flex; flex-direction: column; min-width: 0; padding: 20px 12px 14px; background: #f8f9fb; border-right: 1px solid #dce1e9; }
.outline-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 7px 16px; }
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
.doc-card { display: flex; align-items: center; gap: 9px; margin-bottom: 20px; padding: 10px; background: #eef1f6; border: 1px solid #e0e5ec; border-radius: 8px; }
.doc-card-icon { display: grid; width: 27px; height: 31px; place-items: center; color: #4d6d9f; font-size: 18px; background: #dce6f5; border-radius: 5px; }
.doc-card-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.doc-card-copy strong { overflow: hidden; color: #354159; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.doc-card-copy span { margin-top: 3px; color: #929cad; font-size: 10px; }
.chapter-label { display: flex; justify-content: space-between; padding: 0 8px 8px; color: #8791a2; font-size: 10px; font-weight: 700; }
.chapter-list { display: flex; flex-direction: column; gap: 3px; }
.chapter-item { display: flex; align-items: center; }
.chapter-row { position: relative; display: flex; flex: 1; align-items: center; gap: 8px; min-width: 0; padding: 10px 5px 10px 8px; text-align: left; background: transparent; border: 0; border-radius: 7px; }
.chapter-row:hover, .chapter-row.active { background: #e8edf5; }
.chapter-row.active::before { position: absolute; top: 8px; bottom: 8px; left: 0; width: 3px; background: #4e6f9e; border-radius: 3px; content: ""; }
.chapter-status { width: 7px; height: 7px; flex: 0 0 auto; background: #c7ced8; border: 1px solid #b7c0cc; border-radius: 50%; }
.chapter-status.status-in_progress { background: #6e9fc1; border-color: #5b89ab; }
.chapter-status.status-completed { background: #d8b576; border-color: #c79f5d; }
.chapter-status.status-unassigned { background: #c7ced8; }
.chapter-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.chapter-copy strong { overflow: hidden; color: #445069; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chapter-row.active .chapter-copy strong { color: #28456e; }
.chapter-copy span, .chapter-progress { margin-top: 3px; color: #9aa4b3; font-size: 9px; }
.chapter-progress { white-space: nowrap; }
.chapter-edit { align-self: stretch; padding: 0 3px; color: #8e9aab; font-size: 9px; background: transparent; border: 0; opacity: 0; }
.chapter-item:hover .chapter-edit, .chapter-edit:focus { opacity: 1; }
.chapter-edit:hover { color: #49698f; }
.chapter-empty { padding: 15px 8px; color: #a1aab7; font-size: 10px; text-align: center; background: #f3f5f8; border: 1px dashed #dce2ea; border-radius: 6px; }
.chapter-setup-button { width: 100%; margin-top: 8px; padding: 7px; color: #49698f; font-size: 10px; background: #f1f5fa; border: 1px solid #d8e2ee; border-radius: 6px; }
.chapter-setup-button:hover { background: #e7eef8; }
.chapter-form { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding: 10px; background: #fff; border: 1px solid #dce4ee; border-radius: 7px; }
.chapter-form-heading { color: #4b5d78; font-size: 11px; font-weight: 700; }
.chapter-form label { display: flex; flex-direction: column; gap: 4px; color: #758197; font-size: 9px; }
.chapter-form input, .chapter-form select { width: 100%; padding: 6px 7px; color: #3d4b64; font-size: 10px; background: #fbfcfd; border: 1px solid #dfe5ed; border-radius: 4px; }
.chapter-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.chapter-form-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.chapter-form-actions button { padding: 5px 8px; color: #718096; font-size: 9px; background: transparent; border: 1px solid #dce2ea; border-radius: 4px; }
.chapter-form-actions .primary { color: #fff; background: #4e6f9d; border-color: #4e6f9d; }
.outline-note { margin: 9px 7px 0; color: #71819a; font-size: 9px; }
.outline-error { margin: 7px 7px 0; color: #a55555; font-size: 9px; line-height: 1.4; }
.outline-footer { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin-top: auto; padding: 14px 7px 0; border-top: 1px solid #e5e9ef; }
.team-title { width: 100%; color: #7c8799; font-size: 10px; }
.team-icon { margin-right: 5px; color: #b18a4e; font-size: 16px; }
.team-avatars { display: flex; }
.mini-avatar { display: grid; width: 23px; height: 23px; place-items: center; margin-right: -4px; color: #fff; font-size: 9px; border: 2px solid #f8f9fb; border-radius: 50%; }
.mini-avatar.gold { background: #b68c4c; } .mini-avatar.blue { background: #6681a8; } .mini-avatar.gray { background: #9ca8b9; }
.team-note { margin-left: auto; color: #a2aab7; font-size: 8px; }
</style>
