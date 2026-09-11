<script setup lang="ts">
import { ref } from 'vue'
import { PdfAnnotator, type Annotation } from 'inklayer-vue'
import 'inklayer-vue/style'

import DocumentOutline from './components/DocumentOutline.vue'
import IssueEditor from './components/IssueEditor.vue'
import IssueList from './components/IssueList.vue'
import InkLayerActions from './components/InkLayerActions.vue'
import { useProofreadingWorkspace } from './features/proofreading/useProofreadingWorkspace'

const pdfUrl = 'https://inklayer.dev/inklayer-demo.pdf'
const currentUser = { id: 'proofreader-demo', name: '校对员' }
const activeChapter = ref('chapter-1')

const {
  annotations,
  issues,
  selectedIssueId,
  selectedIssue,
  lastSavedAt,
  addManualIssue,
  selectIssue,
  updateIssue,
  updateIssueStatus,
  handleAnnotationAdded,
  handleAnnotationDeleted,
  handleAnnotationSelected,
  handleAnnotationUpdated,
  handleSave,
  exportIssues,
} = useProofreadingWorkspace(currentUser.name)

function onAnnotationSelected(annotation: Annotation | null) {
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
        <strong>民法学教程（总论）</strong>
        <span class="context-divider">/</span>
        <span>第一章 法律制度导论</span>
      </div>

      <div class="header-actions">
        <span class="save-indicator">
          <span class="save-dot" />
          {{ lastSavedAt ? `已保存 ${lastSavedAt}` : '本地自动保存' }}
        </span>
        <button class="header-button" type="button" @click="exportIssues">
          <span aria-hidden="true">↥</span>
          导出校对表
        </button>
        <div class="user-avatar" aria-label="当前校对人">校</div>
      </div>
    </header>

    <div class="workspace-grid">
      <DocumentOutline v-model:active-chapter="activeChapter" />

      <section class="reader-panel" aria-label="PDF 阅读器">
        <div class="reader-toolbar">
          <div class="reader-title">
            <span class="reader-file-icon">PDF</span>
            <div>
              <strong>民法学教程（总论）</strong>
              <span>教材校对稿 · v0.1</span>
            </div>
          </div>
          <div class="reader-hint">
            <span class="shortcut-key">⌘</span>
            选中文字即可添加高亮或批注
          </div>
        </div>

        <div class="inklayer-frame">
          <PdfAnnotator
            :url="pdfUrl"
            :user="currentUser"
            locale="zh-CN"
            theme="indigo"
            initial-scale="auto"
            :layout-style="{ width: '100%', height: '100%' }"
            :default-show-annotations-sidebar="true"
            :default-show-annotation-author-labels="false"
            :initial-annotations="annotations"
            :actions="InkLayerActions"
            @save="handleSave"
            @annotation-added="handleAnnotationAdded"
            @annotation-deleted="handleAnnotationDeleted"
            @annotation-selected="onAnnotationSelected"
            @annotation-updated="handleAnnotationUpdated"
          />
        </div>
      </section>

      <aside class="review-panel" aria-label="校对意见">
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
        />
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
.save-dot { width: 7px; height: 7px; background: #66c2a3; border-radius: 50%; box-shadow: 0 0 0 3px rgba(102, 194, 163, 0.14); }
.header-button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; color: #e9eef8; font-size: 12px; background: #253149; border: 1px solid #3b4963; border-radius: 7px; }
.header-button:hover { background: #30405d; }
.user-avatar { display: grid; width: 28px; height: 28px; place-items: center; color: #172033; font-weight: 700; font-size: 11px; background: #e2c58f; border-radius: 50%; }

.workspace-grid { display: grid; flex: 1; grid-template-columns: 220px minmax(480px, 1fr) 390px; min-height: 0; }
.reader-panel, .review-panel { min-width: 0; min-height: 0; }
.reader-panel { display: flex; flex-direction: column; padding: 15px 16px 16px; background: #e9edf3; }
.reader-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 4px 11px; }
.reader-title { gap: 9px; min-width: 0; }
.reader-file-icon { display: grid; width: 27px; height: 31px; place-items: center; color: #a54848; font-size: 8px; font-weight: 800; background: #f9e7e7; border: 1px solid #e8c8c8; border-radius: 4px; }
.reader-title strong, .reader-title span { display: block; }
.reader-title strong { overflow: hidden; color: #263149; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.reader-title div span { margin-top: 3px; color: #8a94a7; font-size: 10px; }
.reader-hint { display: flex; align-items: center; gap: 6px; color: #7f8ba0; font-size: 10px; }
.shortcut-key { display: inline-grid; width: 17px; height: 17px; place-items: center; color: #6d7890; font-size: 11px; background: #dce2ea; border: 1px solid #cbd3df; border-radius: 4px; }
.inklayer-frame { flex: 1; min-height: 0; overflow: hidden; background: #cdd4df; border: 1px solid #c0c9d6; border-radius: 9px; box-shadow: 0 5px 16px rgba(31, 42, 61, 0.08); }
.inklayer-frame > * { width: 100%; height: 100%; }
.review-panel { display: flex; flex-direction: column; background: #fff; border-left: 1px solid #dce1e9; }

@media (max-width: 1320px) {
  .workspace-grid { grid-template-columns: 200px minmax(440px, 1fr) 360px; }
  .reader-hint { display: none; }
}
</style>

