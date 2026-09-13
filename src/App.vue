<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PdfAnnotator, type Annotation, type IAnnotationStore, useAnnotationStore } from 'inklayer-vue'
import 'inklayer-vue/style'
import AiCandidateEditor from './components/AiCandidateEditor.vue'
import DocumentOutline from './components/DocumentOutline.vue'
import DocumentUploader from './components/DocumentUploader.vue'
import InkLayerActions from './components/InkLayerActions.vue'
import IssueEditor from './components/IssueEditor.vue'
import IssueList from './components/IssueList.vue'
import ReviewWorkflowBar from './components/ReviewWorkflowBar.vue'
import { useDocumentWorkspace } from './features/documents/useDocumentWorkspace'
import { useAiReviewWorkspace } from './features/proofreading/useAiReviewWorkspace'
import { useProofreadingWorkspace } from './features/proofreading/useProofreadingWorkspace'
import type { AiReviewSummary, ModifiedCandidateResult } from './models/aiReview'
import { buildReviewQueue } from './models/reviewQueue'
import { getAiReviewSummaries } from './services/aiReviewApi'
import { documentFileUrl, type ChapterInput } from './services/documentApi'
import { exportFinalProofreadingCsv } from './services/proofreadingExport'
import { annotationStoresToCore } from './utils/annotationAdapter'

const LEFT_SIDEBAR_STORAGE_KEY = 'proofreading-ui:left-sidebar-collapsed:v1'
const currentUser = { id: 'proofreader-demo', name: '人工复审人' }
const documentStatusLabels = { uploaded:'已上传',inspecting:'检查中',ready:'可校对',failed:'检查失败',registered:'已登记',processing:'处理中' } as const

const documentWorkspace = useDocumentWorkspace()
const {
  documents, selectedDocumentId, selectedDocument, chapters, selectedChapterId, selectedChapter,
  loading:documentLoading, chapterLoading, error, chapterError, loadDocuments, selectDocument, selectChapter,
  createChapter, updateChapter, deletingDocumentId, deleteError, deleteDocumentById,
  textSummary, textError, restartTextExtraction,
} = documentWorkspace

const reviewerName = computed(() => selectedChapter.value?.assigneeName ?? '')
const aiReview = useAiReviewWorkspace(selectedDocumentId, selectedChapterId, reviewerName)
const reviewCompleted = computed(() => aiReview.workspace.value?.stage === 'completed')
const proofreading = useProofreadingWorkspace(reviewerName, selectedDocumentId, selectedChapterId, computed(() => selectedChapter.value?.startPdfPage ?? null), reviewCompleted)
const {
  annotations, issues, selectedIssueId, lastSavedAt, loading:proofreadingLoading, saving, saveError,
  conflict, addManualIssue, selectIssue, updateIssue, deleteIssue, flushPendingSave,
  handleAnnotationAdded, handleAnnotationDeleted, handleAnnotationSelected, handleAnnotationUpdated,
  handleSave, reload:reloadProofreading,
} = proofreading

const leftSidebarCollapsed = ref(typeof window !== 'undefined' && window.localStorage.getItem(LEFT_SIDEBAR_STORAGE_KEY) === 'true')
const aiReviewSummaries = ref<AiReviewSummary[]>([])
const summaryGeneration = ref(0)
const selectedQueueKey = ref<string | null>(null)
const annotationStore = useAnnotationStore()
const reviewQueue = computed(() => buildReviewQueue(aiReview.workspace.value?.candidates ?? [], issues.value))
const selectedQueueItem = computed(() => reviewQueue.value.find((item) => item.key === selectedQueueKey.value) ?? null)

watch(leftSidebarCollapsed, (collapsed) => window.localStorage.setItem(LEFT_SIDEBAR_STORAGE_KEY, String(collapsed)))
watch(() => [selectedDocumentId.value, chapters.value.map((chapter) => chapter.id).join(':')], ([documentId]) => { void loadSummaries(typeof documentId === 'string' ? documentId : null) }, { immediate:true })
watch([selectedChapterId, reviewQueue], () => {
  if (selectedQueueKey.value && reviewQueue.value.some((item) => item.key === selectedQueueKey.value)) return
  selectedQueueKey.value = reviewQueue.value.find((item) => item.source === 'ai' && item.entry.resolution.status === 'pending')?.key ?? reviewQueue.value[0]?.key ?? null
  if (selectedQueueItem.value?.source === 'human') selectIssue(selectedQueueItem.value.issue.id)
}, { immediate:true })

const pdfUrl = computed(() => selectedDocument.value ? documentFileUrl(selectedDocument.value.id) : '')
const selectedDocumentStatus = computed(() => selectedDocument.value ? documentStatusLabels[selectedDocument.value.processingStatus] : '')
const documentContext = computed(() => selectedDocument.value ? `${selectedDocument.value.pageCount} 页 · ${selectedDocumentStatus.value}${selectedChapter.value ? ` · ${selectedChapter.value.title}` : ''}` : '选择或上传一份教材')
const saveIndicator = computed(() => !selectedDocument.value ? '尚未选择教材' : !selectedChapter.value ? '浏览模式' : proofreadingLoading.value ? '正在加载' : conflict.value ? '存在版本冲突' : saving.value ? '正在保存' : saveError.value ? '保存失败' : lastSavedAt.value ? `已保存 ${lastSavedAt.value}` : '尚未保存')
const annotationPermissions = computed(() => selectedChapter.value && !reviewCompleted.value ? undefined : { can: () => false })
const inkLayerInitialAnnotations = computed(() => selectedChapter.value ? annotationStoresToCore(annotations.value) : [])
const exportReady = computed(() => Boolean(selectedChapter.value && aiReview.workspace.value?.stage === 'completed'))

async function loadSummaries(documentId = selectedDocumentId.value) {
  const generation = ++summaryGeneration.value
  aiReviewSummaries.value = []
  if (!documentId) return
  try { const result = await getAiReviewSummaries(documentId); if (generation === summaryGeneration.value) aiReviewSummaries.value = result.reviews } catch { if (generation === summaryGeneration.value) aiReviewSummaries.value = [] }
}
async function refreshAfterAiAction(operation: () => Promise<unknown>) { await operation(); await loadSummaries() }
function selectQueueItem(key:string){selectedQueueKey.value=key;const item=reviewQueue.value.find((entry)=>entry.key===key);if(item?.source==='human')selectIssue(item.issue.id)}
function createManualIssue(){if(reviewCompleted.value)return;addManualIssue();if(selectedIssueId.value)selectedQueueKey.value=`human:${selectedIssueId.value}`}
async function completeReview(){await flushPendingSave();if(conflict.value||saveError.value)return;await refreshAfterAiAction(aiReview.completeHumanReview)}
function exportReview(){const workspace=aiReview.workspace.value;if(!workspace)return;exportFinalProofreadingCsv(workspace.stage,workspace.candidates,issues.value,reviewerName.value)}
async function onDocumentDelete(documentId:string){await flushPendingSave();await deleteDocumentById(documentId)}
function onIssueDeleted(issueId:string){if(reviewCompleted.value)return;const issue=issues.value.find((item)=>item.id===issueId);if(!issue)return;const annotation=annotations.value.find((item)=>item.id===issue.annotationId);if(annotation)annotationStore.painter?.delete(annotation.id,false);deleteIssue(issueId)}
async function onChapterCreated(payload:ChapterInput,onSuccess:()=>void){const chapter=await createChapter(payload);if(chapter){onSuccess();await loadSummaries()}}
async function onChapterUpdated(chapterId:string,payload:ChapterInput,onSuccess:()=>void){const chapter=await updateChapter(chapterId,payload);if(chapter){onSuccess();await loadSummaries()}}
function onAnnotationSelected(annotation:Annotation|IAnnotationStore|null){handleAnnotationSelected(annotation);if(annotation){const issue=issues.value.find((item)=>item.annotationId===annotation.id);if(issue)selectedQueueKey.value=`human:${issue.id}`}}
function modifyCandidate(id:string,result:ModifiedCandidateResult){void refreshAfterAiAction(()=>aiReview.modifyCandidate(id,result))}
function reloadAll(){void Promise.all([reloadProofreading(),aiReview.reload(),loadSummaries()])}

onMounted(() => { void loadDocuments() })
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <div class="brand-lockup"><div class="brand-mark">法</div><div><div class="brand-name">法典校对台</div><div class="brand-subtitle">法律教材 · PDF 校对工作台</div></div></div>
      <div class="document-context"><span class="context-eyebrow">当前文档</span><strong>{{ selectedDocument?.title ?? '尚未上传教材' }}</strong><span class="context-divider">/</span><span>{{ documentContext }}</span></div>
      <div class="header-actions">
        <span class="save-indicator" :class="{'save-indicator-alert':conflict||saveError}"><span class="save-dot"/>{{ saveIndicator }}</span>
        <button v-if="conflict" class="header-link" type="button" @click="reloadAll">重新加载</button>
        <button class="header-button" type="button" :disabled="!exportReady" :title="exportReady?'导出最终校对表':'完成本章人工复审后可导出最终校对表'" @click="exportReview"><span>↥</span>导出校对表</button>
        <div class="user-avatar" aria-label="当前用户">人</div>
      </div>
    </header>
    <div class="workspace-grid" :class="{'left-sidebar-collapsed':leftSidebarCollapsed}">
      <div class="outline-column" :class="{collapsed:leftSidebarCollapsed}">
        <div class="outline-uploader"><DocumentUploader @completed="(id)=>loadDocuments(id)"/></div>
        <DocumentOutline :documents="documents" :selected-document-id="selectedDocumentId" :chapters="chapters" :selected-chapter-id="selectedChapterId" :loading="documentLoading" :chapter-loading="chapterLoading" :error="error" :chapter-error="chapterError" :collapsed="leftSidebarCollapsed" :deleting-document-id="deletingDocumentId" :delete-error="deleteError" :text-summary="textSummary" :text-error="textError" :ai-reviews="aiReviewSummaries" @select="(id)=>selectDocument(id)" @select-chapter="selectChapter" @create-chapter="onChapterCreated" @update-chapter="onChapterUpdated" @delete-document="onDocumentDelete" @extract-text="restartTextExtraction"/>
        <button class="sidebar-toggle" type="button" :aria-label="leftSidebarCollapsed?'展开目录':'收起目录'" @click="leftSidebarCollapsed=!leftSidebarCollapsed"><span>{{ leftSidebarCollapsed?'›':'‹' }}</span><span class="sidebar-toggle-label">{{ leftSidebarCollapsed?'展开目录':'收起目录' }}</span></button>
      </div>
      <section class="reader-panel" aria-label="PDF 阅读器">
        <div class="reader-toolbar"><div class="reader-title"><span class="reader-file-icon">PDF</span><div><strong>{{ selectedDocument?.title??'尚未上传教材' }}</strong><span>{{ selectedChapter?`本章 PDF ${selectedChapter.startPdfPage}–${selectedChapter.endPdfPage} 页 · ${selectedChapter.title}`:selectedDocument?'整本 PDF · 浏览/章节划分模式':'上传 PDF 后开始校对' }}</span></div></div><div class="reader-hint"><template v-if="selectedChapter&&!reviewCompleted"><span class="shortcut-key">⌘</span>选中文字即可添加高亮或批注</template><span v-else-if="reviewCompleted">本章复审已完成 · PDF 只读</span><span v-else-if="selectedDocument">浏览模式 · 建立或选择章节后开始校对</span></div></div>
        <div class="inklayer-frame">
          <PdfAnnotator v-if="selectedDocument?.processingStatus==='ready'&&!proofreadingLoading" :key="`${selectedDocument.id}:${selectedChapter?.id??'browse'}`" :url="pdfUrl" :user="currentUser" locale="zh-CN" theme="indigo" initial-scale="auto" :layout-style="{width:'100%',height:'100%'}" :default-show-annotations-sidebar="true" :default-show-annotation-author-labels="false" :initial-annotations="inkLayerInitialAnnotations" :actions="selectedChapter&&!reviewCompleted?InkLayerActions:undefined" :annotation-permissions="annotationPermissions" @save="handleSave" @annotation-added="handleAnnotationAdded" @annotation-deleted="handleAnnotationDeleted" @annotation-selected="onAnnotationSelected" @annotation-updated="handleAnnotationUpdated"/>
          <div v-else class="reader-empty"><div class="reader-empty-icon">PDF</div><strong>{{ selectedDocument?.processingStatus==='failed'?'PDF 检查失败':proofreadingLoading?'正在加载校对数据…':selectedDocument?'PDF 正在准备':'选择或上传一份教材' }}</strong></div>
        </div>
      </section>
      <aside class="review-panel" aria-label="校对意见">
        <template v-if="selectedDocument&&selectedChapter">
          <ReviewWorkflowBar :workspace="aiReview.workspace.value" :assignee-name="reviewerName" :manual-count="issues.length" :loading="aiReview.loading.value" :acting="aiReview.acting.value" :error="aiReview.error.value" :conflict="aiReview.conflict.value" @start="refreshAfterAiAction(aiReview.startHumanReview)" @complete="completeReview" @reload="reloadAll"/>
          <IssueList :items="reviewQueue" :selected-key="selectedQueueKey" :read-only="reviewCompleted" @select="selectQueueItem" @create="createManualIssue"/>
          <AiCandidateEditor v-if="selectedQueueItem?.source==='ai'" :entry="selectedQueueItem.entry" :stage="aiReview.workspace.value?.stage??'awaiting_ai'" :reviewer-name="reviewerName" :acting="aiReview.acting.value" @accept="(id)=>refreshAfterAiAction(()=>aiReview.acceptCandidate(id))" @reject="(id)=>refreshAfterAiAction(()=>aiReview.rejectCandidate(id))" @modify="modifyCandidate"/>
          <IssueEditor v-else :issue="selectedQueueItem?.source==='human'?selectedQueueItem.issue:null" :reviewer-name="reviewerName" :read-only="reviewCompleted" @update="updateIssue" @delete="onIssueDeleted"/>
        </template>
        <div v-else class="review-empty"><div class="reader-empty-icon">✎</div><strong>{{ selectedDocument?'请选择或建立章节':'选择或上传一份教材' }}</strong><span>校对意见按章节分别保存</span></div>
      </aside>
    </div>
  </main>
</template>

<style>
:root{color:#172033;background:#eef1f6;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-synthesis:none;text-rendering:optimizeLegibility}*{box-sizing:border-box}body{margin:0;min-width:1180px;min-height:100vh}button,input,select,textarea{font:inherit}button{cursor:pointer}.app-shell{display:flex;flex-direction:column;height:100vh;min-height:720px;overflow:hidden;background:#f3f5f9}.app-header{display:flex;align-items:center;gap:28px;height:66px;padding:0 22px;color:#f7f9fd;background:#172033;border-bottom:1px solid #29344a}.brand-lockup,.document-context,.header-actions,.reader-title,.save-indicator{display:flex;align-items:center}.brand-lockup{flex:0 0 220px;gap:10px}.brand-mark{display:grid;width:34px;height:34px;place-items:center;color:#172033;font-size:18px;font-weight:800;background:#c8a977;border-radius:9px}.brand-name{font-size:15px;font-weight:700;letter-spacing:.04em}.brand-subtitle{margin-top:2px;color:#9ea8bc;font-size:11px}.document-context{flex:1;gap:10px;min-width:0;color:#c4ccda;font-size:12px}.document-context strong{color:#fff;font-size:13px}.context-eyebrow{color:#7f8ba4;font-size:11px}.context-divider{color:#58647a}.header-actions{gap:14px}.save-indicator{gap:7px;color:#aab4c6;font-size:11px;white-space:nowrap}.save-indicator-alert{color:#e7b4a2}.save-dot{width:7px;height:7px;background:#66c2a3;border-radius:50%;box-shadow:0 0 0 3px rgba(102,194,163,.14)}.header-link{padding:0;color:#e7c68f;font-size:10px;background:transparent;border:0}.header-button{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;color:#e9eef8;font-size:12px;background:#253149;border:1px solid #3b4963;border-radius:7px}.header-button:disabled{cursor:not-allowed;opacity:.5}.user-avatar{display:grid;width:28px;height:28px;place-items:center;color:#172033;font-size:11px;font-weight:700;background:#e2c58f;border-radius:50%}.workspace-grid{--left-sidebar-width:260px;display:grid;flex:1;grid-template-columns:var(--left-sidebar-width) minmax(480px,1fr) 420px;min-height:0;transition:grid-template-columns .18s ease}.workspace-grid.left-sidebar-collapsed{--left-sidebar-width:48px}.outline-column{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:#f8f9fb}.outline-uploader{overflow:hidden;transition:opacity .15s ease,height .18s ease}.outline-column.collapsed .outline-uploader{height:0;opacity:0;visibility:hidden;pointer-events:none}.outline-column.collapsed .outline-panel{padding:0}.sidebar-toggle{position:absolute;top:12px;right:-13px;z-index:50;display:inline-flex;align-items:center;gap:3px;min-height:28px;padding:5px 7px;color:#61718a;font-size:10px;background:#fff;border:1px solid #cfd8e4;border-radius:6px;box-shadow:0 3px 8px rgba(31,42,61,.12)}.outline-column.collapsed .sidebar-toggle{right:-10px;width:28px;justify-content:center;padding:5px 4px;font-size:17px}.outline-column.collapsed .sidebar-toggle-label{display:none}.outline-column>.outline-panel{flex:1;min-height:0}.reader-panel,.review-panel{min-width:0;min-height:0}.reader-panel{display:flex;flex-direction:column;padding:15px 16px 16px;background:#e9edf3}.reader-toolbar{display:flex;align-items:center;justify-content:space-between;min-height:48px;padding:0 4px 11px}.reader-title{gap:9px;min-width:0}.reader-file-icon{display:grid;width:27px;height:31px;place-items:center;color:#a54848;font-size:8px;font-weight:800;background:#f9e7e7;border:1px solid #e8c8c8;border-radius:4px}.reader-title strong,.reader-title span{display:block}.reader-title strong{overflow:hidden;color:#263149;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.reader-title div span{margin-top:3px;color:#8a94a7;font-size:10px}.reader-hint{display:flex;align-items:center;gap:6px;color:#7f8ba0;font-size:10px}.shortcut-key{display:inline-grid;width:17px;height:17px;place-items:center;background:#dce2ea;border:1px solid #cbd3df;border-radius:4px}.inklayer-frame{flex:1;min-height:0;overflow:hidden;background:#cdd4df;border:1px solid #c0c9d6;border-radius:9px;box-shadow:0 5px 16px rgba(31,42,61,.08)}.inklayer-frame>*{width:100%;height:100%}.review-panel{display:flex;flex-direction:column;background:#fff;border-left:1px solid #dce1e9}.reader-empty,.review-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:30px;color:#9da7b5;text-align:center}.reader-empty strong,.review-empty strong{color:#6e7c91;font-size:12px}.review-empty span{font-size:10px}.reader-empty-icon{display:grid;width:42px;height:42px;place-items:center;color:#7894b7;font-size:11px;font-weight:700;background:#eef4fb;border-radius:50%}@media(max-width:1320px){.workspace-grid{--left-sidebar-width:250px;grid-template-columns:var(--left-sidebar-width) minmax(440px,1fr) 390px}.workspace-grid.left-sidebar-collapsed{--left-sidebar-width:48px}.reader-hint{display:none}}
</style>
