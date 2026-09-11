<script setup lang="ts">
import { computed } from 'vue'
import type { ApiDocument } from '../services/documentApi'

const props = defineProps<{
  documents: readonly ApiDocument[]
  selectedDocumentId: string | null
  loading: boolean
  error: string
}>()

const emit = defineEmits<{ select: [documentId: string] }>()

const selectedDocument = computed(() =>
  props.documents.find((document) => document.id === props.selectedDocumentId) ?? null,
)

const statusLabels = {
  uploaded: '已上传',
  inspecting: '检查中',
  ready: '可校对',
  failed: '检查失败',
  registered: '已登记',
  processing: '处理中',
} as const

function statusLabel(status: ApiDocument['processingStatus']) {
  return statusLabels[status] ?? status
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
        <span>{{ document.pageCount }} 页 · {{ statusLabel(document.processingStatus) }}</span>
      </button>
    </div>
    <div v-else class="empty-document">
      <strong>尚未上传教材</strong>
      <span>选择一个 PDF 开始校对</span>
    </div>

    <div v-if="selectedDocument" class="doc-card">
      <div class="doc-card-icon">§</div>
      <div class="doc-card-copy"><strong>{{ selectedDocument.title }}</strong><span>{{ selectedDocument.pageCount }} 页 · {{ statusLabel(selectedDocument.processingStatus) }}</span></div>
    </div>

    <div class="chapter-label"><span>章节</span><span class="chapter-count">{{ selectedDocument ? selectedDocument.pageCount : '—' }}</span></div>

    <div class="chapter-empty">章节信息待建立</div>
    <p v-if="loading" class="outline-note">正在加载文档…</p>
    <p v-if="error" class="outline-error" role="alert">{{ error }}</p>

    <div class="outline-footer">
      <div class="team-title"><span class="team-icon">♧</span> 校对协作</div>
      <div class="team-avatars"><span class="mini-avatar gold">校</span><span class="mini-avatar blue">复</span><span class="mini-avatar gray">+2</span></div>
      <span class="team-note">本地 MVP</span>
    </div>
  </aside>
</template>

<style scoped>
.outline-panel { display: flex; flex-direction: column; min-width: 0; padding: 20px 12px 14px; background: #f8f9fb; border-right: 1px solid #dce1e9; }
.outline-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 7px 16px; }
.panel-kicker { color: #99a2b2; font-size: 9px; font-weight: 700; letter-spacing: .14em; }
h2 { margin: 4px 0 0; color: #253047; font-size: 17px; }
.document-count { display: grid; min-width: 21px; height: 18px; padding: 0 5px; place-items: center; color: #728096; font-size: 9px; background: #e8edf4; border-radius: 9px; }
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
.doc-card-menu { color: #98a2b2; font-size: 15px; }
.chapter-label { display: flex; justify-content: space-between; padding: 0 8px 8px; color: #8791a2; font-size: 10px; font-weight: 700; }
.chapter-count { display: grid; min-width: 21px; height: 18px; padding: 0 5px; place-items: center; color: #728096; font-size: 9px; background: #e8edf4; border-radius: 9px; }
.chapter-empty { padding: 15px 8px; color: #a1aab7; font-size: 10px; text-align: center; background: #f3f5f8; border: 1px dashed #dce2ea; border-radius: 6px; }
.outline-note { margin: 9px 7px 0; color: #71819a; font-size: 9px; }
.outline-error { margin: 7px 7px 0; color: #a55555; font-size: 9px; line-height: 1.4; }
.chapter-list { display: flex; flex-direction: column; gap: 3px; }
.chapter-row { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 8px; text-align: left; background: transparent; border: 0; border-radius: 7px; }
.chapter-row:hover, .chapter-row.active { background: #e8edf5; }
.chapter-row.active::before { position: absolute; top: 8px; bottom: 8px; left: 0; width: 3px; background: #4e6f9e; border-radius: 3px; content: ""; }
.chapter-status { width: 7px; height: 7px; flex: 0 0 auto; background: #c7ced8; border: 1px solid #b7c0cc; border-radius: 50%; }
.chapter-status.done { background: #d8b576; border-color: #c79f5d; }
.chapter-copy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.chapter-copy strong { overflow: hidden; color: #445069; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.chapter-row.active .chapter-copy strong { color: #28456e; }
.chapter-copy span, .chapter-progress { margin-top: 3px; color: #9aa4b3; font-size: 9px; }
.chapter-progress { white-space: nowrap; }
.outline-footer { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin-top: auto; padding: 14px 7px 0; border-top: 1px solid #e5e9ef; }
.team-title { width: 100%; color: #7c8799; font-size: 10px; }
.team-icon { margin-right: 5px; color: #b18a4e; font-size: 16px; }
.team-avatars { display: flex; }
.mini-avatar { display: grid; width: 23px; height: 23px; place-items: center; margin-right: -4px; color: #fff; font-size: 9px; border: 2px solid #f8f9fb; border-radius: 50%; }
.mini-avatar.gold { background: #b68c4c; } .mini-avatar.blue { background: #6681a8; } .mini-avatar.gray { background: #9ca8b9; }
.team-note { margin-left: auto; color: #a2aab7; font-size: 9px; }
</style>
