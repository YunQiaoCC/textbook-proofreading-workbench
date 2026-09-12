<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PdfAnnotator, type Annotation, type IAnnotationStore, useAnnotationStore } from 'inklayer-vue'
import 'inklayer-vue/style'

import DocumentUploader from './components/DocumentUploader.vue'
import DocumentOutline from './components/DocumentOutline.vue'
import IssueEditor from './components/IssueEditor.vue'
import IssueList from './components/IssueList.vue'
import InkLayerActions from './components/InkLayerActions.vue'
import { documentFileUrl } from './services/documentApi'
import type { ChapterInput } from './services/documentApi'
import { useDocumentWorkspace } from './features/documents/useDocumentWorkspace'
import { useProofreadingWorkspace } from './features/proofreading/useProofreadingWorkspace'
import { annotationStoresToCore } from './utils/annotationAdapter'

const LEFT_SIDEBAR_STORAGE_KEY = 'proofreading-ui:left-sidebar-collapsed:v1'

function readLeftSidebarCollapsed() {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(LEFT_SIDEBAR_STORAGE_KEY) === 'true'
}

const currentUser = { id: 'proofreader-demo', name: '校对员' }
const documentStatusLabels = {
  uploaded: '已上传',
  inspecting: '检查中',
  ready: '可校对',
  failed: '检查失败',
  registered: '已登记',
  processing: '处理中',
} as const

const {
  documents,
  selectedDocumentId,
  selectedDocument,
  chapters,
  selectedChapterId,
  selectedChapter,
  loading: documentLoading,
  chapterLoading,
  error,
  chapterError,
  loadDocuments,
  selectDocument,
  selectChapter,
  createChapter,
  updateChapter,
  deletingDocumentId,
  deleteError,
  deleteDocumentById,
  textSummary,
  textError,
  restartTextExtraction,
} = useDocumentWorkspace()

const {
  annotations,
  issues,
  selectedIssueId,
  selectedIssue,
  lastSavedAt,
  loading: proofreadingLoading,
  saving,
  saveError,
  conflict,
  addManualIssue,
  selectIssue,
  updateIssue,
  updateIssueStatus,
  deleteIssue,
  flushPendingSave,
  handleAnnotationAdded,
  handleAnnotationDeleted,
  handleAnnotationSelected,
  handleAnnotationUpdated,
  handleSave,
  reload,
  exportIssues,
} = useProofreadingWorkspace(
  currentUser.name,
  selectedDocumentId,
  selectedChapterId,
  computed(() => selectedChapter.value?.startPdfPage ?? null),
)

const leftSidebarCollapsed = ref(readLeftSidebarCollapsed())
const annotationStore = useAnnotationStore()

watch(leftSidebarCollapsed, (collapsed) => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LEFT_SIDEBAR_STORAGE_KEY, String(collapsed))
  }
})

const pdfUrl = computed(() => selectedDocument.value ? documentFileUrl(selectedDocument.value.id) : '')
const selectedDocumentStatus = computed(() => {
  const status = selectedDocument.value?.processingStatus
  return status ? documentStatusLabels[status] : ''
})
const documentContext = computed(() => selectedDocument.value
  ? `${selectedDocument.value.pageCount} 页 · ${selectedDocumentStatus.value}${selectedChapter.value ? ` · ${selectedChapter.value.title}` : ''}`
  : '选择或上传一份教材')
const saveIndicator = computed(() => {
  if (!selectedDocument.value) return '尚未选择教材'
  if (!selectedChapter.value) return '浏览模式'
  if (proofreadingLoading.value) return '正在加载'
  if (conflict.value) return '存在版本冲突'
  if (saving.value) return '正在保存'
  if (saveError.value) return '保存失败'
  return lastSavedAt.value ? `已保存 ${lastSavedAt.value}` : '尚未保存'
})
const annotationPermissions = computed(() => selectedChapter.value
  ? undefined
  : { can: () => false })
const inkLayerInitialAnnotations = computed(() => selectedChapter.value
  ? annotationStoresToCore(annotations.value)
  : [])

onMounted(() => { void loadDocuments() })

function toggleLeftSidebar() {
  leftSidebarCollapsed.value = !leftSidebarCollapsed.value
}

function onDocumentSelected(documentId: string) {
  void selectDocument(documentId)
}

async function onDocumentDelete(documentId: string) {
  await flushPendingSave()
  await deleteDocumentById(documentId)
}

function onIssueDeleted(issueId: string) {
  const issue = issues.value.find((item) => item.id === issueId)
  if (!issue) return
  const annotation = annotations.value.find((item) => item.id === issue.annotationId)
  if (annotation) annotationStore.painter?.delete(annotation.id, false)
  deleteIssue(issueId)
}

function onDocumentUploaded(documentId: string) {
  void loadDocuments(documentId)
}

function onChapterSelected(chapterId: string) {
  selectChapter(chapterId)
}

async function onChapterCreated(payload: ChapterInput, onSuccess: () => void) {
  const chapter = await createChapter(payload)
  if (chapter) onSuccess()
}

async function onChapterUpdated(chapterId: string, payload: ChapterInput, onSuccess: () => void) {
  const chapter = await updateChapter(chapterId, payload)
  if (chapter) onSuccess()
}

function reloadWorkspace() {
  void reload()
}

function onAnnotationSelected(annotation: Annotation | IAnnotationStore | null) {
  handleAnnotationSelected(annotation)
}
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <div class="brand-lockup">
        <div class="brand-mark">法</div>
        <div>
          <div class="brand-name">法典校对台</div>
          <div class="brand-subtitle">法律教材 · PDF 校对工作台</div>
        </div>
      </div>

      <div class="document-context">
        <span class="context-eyebrow">当前文档</span>
        <strong>{{ selectedDocument?.title ?? '尚未上传教材' }}</strong>
        <span class="context-divider">/</span>
        <span>{{ documentContext }}</span>
      </div>

      <div class="header-actions">
        <span class="save-indicator" :class="{ 'save-indicator-alert': conflict || saveError }">
          <span class="save-dot" />
          {{ saveIndicator }}
        </span>
        <button v-if="conflict" class="header-link" type="button" @click="reloadWorkspace">重新加载</button>
        <button class="header-button" type="button" :disabled="!selectedDocument || !selectedChapter" @click="exportIssues">
          <span aria-hidden="true">↥</span>
          导出校对表
        </button>
        <div class="user-avatar" aria-label="当前校对人">校</div>
      </div>
    </header>

      <div class="workspace-grid" :class="{ 'left-sidebar-collapsed': leftSidebarCollapsed }">
      <div class="outline-column" :class="{ collapsed: leftSidebarCollapsed }">
        <div class="outline-uploader"><DocumentUploader @completed="onDocumentUploaded" /></div>
        <DocumentOutline
          :documents="documents"
          :selected-document-id="selectedDocumentId"
          :chapters="chapters"
          :selected-chapter-id="selectedChapterId"
          :loading="documentLoading"
          :chapter-loading="chapterLoading"
          :error="error"
          :chapter-error="chapterError"
          :collapsed="leftSidebarCollapsed"
          :deleting-document-id="deletingDocumentId"
          :delete-error="deleteError"
          :text-summary="textSummary"
          :text-error="textError"
          @select="onDocumentSelected"
          @select-chapter="onChapterSelected"
          @create-chapter="onChapterCreated"
          @update-chapter="onChapterUpdated"
          @delete-document="onDocumentDelete"
          @extract-text="restartTextExtraction"
        />
        <button
          class="sidebar-toggle"
          type="button"
          :aria-label="leftSidebarCollapsed ? '\u5c55\u5f00\u76ee\u5f55' : '\u6536\u8d77\u76ee\u5f55'"
          :title="leftSidebarCollapsed ? '\u5c55\u5f00\u76ee\u5f55' : '\u6536\u8d77\u76ee\u5f55'"
          @click="toggleLeftSidebar"
        >
          <span aria-hidden="true" v-if="leftSidebarCollapsed">&rsaquo;</span>
          <span aria-hidden="true" v-else>&lsaquo;</span>
          <span class="sidebar-toggle-label">{{ leftSidebarCollapsed ? '\u5c55\u5f00\u76ee\u5f55' : '\u6536\u8d77\u76ee\u5f55' }}</span>
        </button>
      </div>

      <section class="reader-panel" aria-label="PDF 阅读器">
        <div class="reader-toolbar">
          <div class="reader-title">
            <span class="reader-file-icon">PDF</span>
            <div>
              <strong>{{ selectedDocument?.title ?? '尚未上传教材' }}</strong>
                <span>{{ selectedChapter ? `本章 PDF ${selectedChapter.startPdfPage}–${selectedChapter.endPdfPage} 页 · ${selectedChapter.title}` : selectedDocument ? '整本 PDF · 浏览/章节划分模式' : '上传 PDF 后开始校对' }}</span>
            </div>
          </div>
          <div class="reader-hint">
            <template v-if="selectedChapter">
              <span class="shortcut-key">⌘</span>
              选中文字即可添加高亮或批注
            </template>
            <span v-else-if="selectedDocument">浏览模式 · 建立或选择章节后开始校对</span>
          </div>
        </div>

        <div class="inklayer-frame">
          <PdfAnnotator
            v-if="selectedDocument?.processingStatus === 'ready' && !proofreadingLoading"
            :key="`${selectedDocument.id}:${selectedChapter?.id ?? 'browse'}`"
            :url="pdfUrl"
            :user="currentUser"
            locale="zh-CN"
            theme="indigo"
            initial-scale="auto"
            :layout-style="{ width: '100%', height: '100%' }"
            :default-show-annotations-sidebar="true"
            :default-show-annotation-author-labels="false"
            :initial-annotations="inkLayerInitialAnnotations"
            :actions="selectedChapter ? InkLayerActions : undefined"
            :annotation-permissions="annotationPermissions"
            @save="handleSave"
            @annotation-added="handleAnnotationAdded"
            @annotation-deleted="handleAnnotationDeleted"
            @annotation-selected="onAnnotationSelected"
            @annotation-updated="handleAnnotationUpdated"
          />
          <div v-else class="reader-empty">
            <div class="reader-empty-icon">PDF</div>
            <strong>{{ selectedDocument?.processingStatus === 'failed' ? 'PDF 检查失败' : proofreadingLoading ? '正在加载校对数据…' : selectedDocument ? 'PDF 正在准备' : '选择或上传一份教材' }}</strong>
            <span>{{ selectedDocument?.processingStatus === 'failed' ? '请检查文件后重试' : proofreadingLoading ? '正在从服务器读取本章校对意见' : selectedDocument ? 'PDF 检查完成后即可浏览整本内容' : documents.length ? '从左侧选择一份教材' : '尚未上传教材' }}</span>
          </div>
        </div>
      </section>

      <aside class="review-panel" aria-label="校对意见">
        <template v-if="selectedDocument && selectedChapter">
          <IssueList
            :issues="issues"
            :selected-issue-id="selectedIssueId"
            @select="selectIssue"
            @create="addManualIssue"
          />
          <IssueEditor
            :issue="selectedIssue"
            @update="updateIssue"
            @status="updateIssueStatus"
            @delete="onIssueDeleted"
          />
        </template>
        <div v-else class="review-empty">
          <div class="reader-empty-icon">✎</div>
          <strong>{{ selectedDocument ? '请选择或建立章节' : '选择或上传一份教材' }}</strong>
          <span>{{ selectedDocument ? '选择章节后，校对意见会按章节分别保存' : '选择或上传一份教材' }}</span>
        </div>
      </aside>
    </div>
  </main>
</template>

<style>
:root {
  color: #172033;
  background: #eef1f6;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 1180px; min-height: 100vh; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }

.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 720px;
  overflow: hidden;
  background: #f3f5f9;
}

.app-header {
  display: flex;
  align-items: center;
  gap: 28px;
  height: 66px;
  padding: 0 22px;
  color: #f7f9fd;
  background: #172033;
  border-bottom: 1px solid #29344a;
}

.brand-lockup, .document-context, .header-actions, .reader-title,
.save-indicator, .issue-card-top, .issue-card-meta, .editor-heading,
.editor-footer, .field-label-row, .outline-heading, .chapter-row,
.empty-state, .panel-heading { display: flex; align-items: center; }

.brand-lockup { flex: 0 0 220px; gap: 10px; }
.brand-mark {
  display: grid; width: 34px; height: 34px; place-items: center;
  color: #172033; font-weight: 800; font-size: 18px; background: #c8a977; border-radius: 9px;
}
.brand-name { font-weight: 700; font-size: 15px; letter-spacing: 0.04em; }
.brand-subtitle { margin-top: 2px; color: #9ea8bc; font-size: 11px; }
.document-context { flex: 1; gap: 10px; min-width: 0; color: #c4ccda; font-size: 12px; }
.document-context strong { color: #fff; font-size: 13px; }
.context-eyebrow { color: #7f8ba4; font-size: 11px; }
.context-divider { color: #58647a; }
.header-actions { gap: 15px; }
.save-indicator { gap: 7px; color: #aab4c6; font-size: 11px; white-space: nowrap; }
.save-indicator-alert { color: #e7b4a2; }
.save-dot { width: 7px; height: 7px; background: #66c2a3; border-radius: 50%; box-shadow: 0 0 0 3px rgba(102, 194, 163, 0.14); }
.header-link { padding: 0; color: #e7c68f; font-size: 10px; background: transparent; border: 0; }
.header-link:hover { color: #fff1ca; }
.header-button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; color: #e9eef8; font-size: 12px; background: #253149; border: 1px solid #3b4963; border-radius: 7px; }
.header-button:hover { background: #30405d; }
.user-avatar { display: grid; width: 28px; height: 28px; place-items: center; color: #172033; font-weight: 700; font-size: 11px; background: #e2c58f; border-radius: 50%; }

.workspace-grid { --left-sidebar-width: 260px; display: grid; flex: 1; grid-template-columns: var(--left-sidebar-width) minmax(480px, 1fr) 390px; min-height: 0; transition: grid-template-columns .18s ease; }
.workspace-grid.left-sidebar-collapsed { --left-sidebar-width: 48px; }
.outline-column { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #f8f9fb; }
.outline-uploader { overflow: hidden; transition: opacity .15s ease, visibility .15s ease, height .18s ease; }
.outline-column.collapsed .outline-uploader { height: 0; opacity: 0; visibility: hidden; pointer-events: none; }
.outline-column.collapsed .outline-panel { padding: 0; }
.sidebar-toggle { position: absolute; top: 12px; right: -13px; z-index: 50; display: inline-flex; align-items: center; gap: 3px; min-height: 28px; padding: 5px 7px; color: #61718a; font-size: 10px; background: #fff; border: 1px solid #cfd8e4; border-radius: 6px; box-shadow: 0 3px 8px rgba(31, 42, 61, .12); }
.sidebar-toggle:hover { color: #30496d; background: #f4f7fb; }
.sidebar-toggle-label { white-space: nowrap; }
.outline-column.collapsed .sidebar-toggle { right: -10px; width: 28px; justify-content: center; padding: 5px 4px; font-size: 17px; }
.outline-column.collapsed .sidebar-toggle-label { display: none; }
.outline-column > .outline-panel { flex: 1; min-height: 0; }
.reader-panel, .review-panel { min-width: 0; min-height: 0; }
.reader-panel { display: flex; flex-direction: column; padding: 15px 16px 16px; background: #e9edf3; }
.reader-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 4px 11px; }
.reader-title { gap: 9px; min-width: 0; }
.reader-file-icon { display: grid; width: 27px; height: 31px; place-items: center; color: #a54848; font-size: 8px; font-weight: 800; background: #f9e7e7; border: 1px solid #e8c8c8; border-radius: 4px; }
.reader-title strong, .reader-title span { display: block; }
.reader-title strong { overflow: hidden; color: #263149; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.reader-title div span { margin-top: 3px; color: #8a94a7; font-size: 10px; }
.header-button:disabled { cursor: not-allowed; opacity: .55; }
.reader-hint { display: flex; align-items: center; gap: 6px; color: #7f8ba0; font-size: 10px; }
.shortcut-key { display: inline-grid; width: 17px; height: 17px; place-items: center; color: #6d7890; font-size: 11px; background: #dce2ea; border: 1px solid #cbd3df; border-radius: 4px; }
.inklayer-frame { flex: 1; min-height: 0; overflow: hidden; background: #cdd4df; border: 1px solid #c0c9d6; border-radius: 9px; box-shadow: 0 5px 16px rgba(31, 42, 61, 0.08); }
.inklayer-frame > * { width: 100%; height: 100%; }
.review-panel { display: flex; flex-direction: column; background: #fff; border-left: 1px solid #dce1e9; }
.reader-empty, .review-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; padding: 30px; color: #9da7b5; text-align: center; }
.reader-empty strong, .review-empty strong { color: #6e7c91; font-size: 12px; }
.reader-empty span, .review-empty span { max-width: 220px; font-size: 10px; line-height: 1.5; }
.reader-empty-icon { display: grid; width: 42px; height: 42px; place-items: center; color: #7894b7; font-size: 11px; font-weight: 700; background: #eef4fb; border-radius: 50%; }

@media (max-width: 1320px) {
  .workspace-grid { --left-sidebar-width: 250px; grid-template-columns: var(--left-sidebar-width) minmax(440px, 1fr) 360px; }
  .workspace-grid.left-sidebar-collapsed { --left-sidebar-width: 48px; }
  .reader-hint { display: none; }
}
</style>
