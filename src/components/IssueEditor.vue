<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { issueCategories, issueStatuses, type ProofreadingIssue, type ProofreadingIssuePatch, type IssueStatus } from '../models/proofreading'

const props = defineProps<{ issue: ProofreadingIssue | null }>()
const emit = defineEmits<{ update: [id: string, patch: ProofreadingIssuePatch]; status: [id: string, status: IssueStatus]; delete: [id: string] }>()

const draft = reactive<ProofreadingIssue>({
  id: '', annotationId: '', pdfPage: 1, printedPage: '', originalText: '', category: 'other',
  suggestion: '', reason: '', status: 'pending', reviewer: '', verifier: '', createdAt: '', updatedAt: '',
})

watch(() => props.issue, (issue) => { if (issue) Object.assign(draft, issue) }, { immediate: true })
const deleteDialogOpen = ref(false)

function openDeleteDialog() {
  if (props.issue) deleteDialogOpen.value = true
}

function closeDeleteDialog() {
  deleteDialogOpen.value = false
}

function confirmDelete() {
  if (!props.issue) return
  emit('delete', props.issue.id)
  deleteDialogOpen.value = false
}


function commit() {
  if (!props.issue) return
  emit('update', props.issue.id, {
    pdfPage: Number(draft.pdfPage) || 1, printedPage: draft.printedPage, originalText: draft.originalText,
    category: draft.category, suggestion: draft.suggestion, reason: draft.reason,
    reviewer: draft.reviewer, verifier: draft.verifier,
  })
}

function setStatus(status: IssueStatus) {
  if (!props.issue) return
  draft.status = status
  emit('status', props.issue.id, status)
}
</script>

<template>
  <section class="editor-panel">
    <div v-if="!issue" class="editor-empty">
      <div class="editor-empty-icon">✎</div>
      <strong>选择一条意见开始校对</strong>
      <span>PDF 中的高亮批注会自动出现在这里</span>
    </div>

    <template v-else>
      <div class="editor-heading">
        <div><span class="panel-kicker">ISSUE DETAIL</span><h2>意见详情</h2></div>
        <span class="issue-id">{{ issue.id.replace('issue-', '#') }}</span>
      </div>

      <div class="editor-scroll">
        <div class="form-grid two-columns">
          <label class="form-field"><span>PDF 页码</span><input v-model.number="draft.pdfPage" min="1" type="number" @blur="commit" /></label>
          <label class="form-field"><span>书中页码</span><input v-model="draft.printedPage" placeholder="如：12" @blur="commit" /></label>
        </div>
        <label class="form-field"><span>原文</span><textarea v-model="draft.originalText" rows="3" placeholder="输入需要校对的原文" @blur="commit" /></label>
        <label class="form-field"><span>问题类型</span><select v-model="draft.category" @change="commit"><option v-for="category in issueCategories" :key="category.value" :value="category.value">{{ category.label }}</option></select></label>
        <label class="form-field"><span>修改建议</span><textarea v-model="draft.suggestion" rows="3" placeholder="填写建议修改后的内容" @blur="commit" /></label>
        <label class="form-field"><span>修改理由 <em>可选</em></span><textarea v-model="draft.reason" rows="3" placeholder="说明依据、规则或判断理由" @blur="commit" /></label>
        <div class="form-grid two-columns">
          <label class="form-field"><span>校对人</span><input v-model="draft.reviewer" @blur="commit" /></label>
          <label class="form-field"><span>复核人 <em>可选</em></span><input v-model="draft.verifier" placeholder="尚未指定" @blur="commit" /></label>
        </div>
        <div class="status-section">
          <div class="field-label-row"><span>校对状态</span><em>点击更新</em></div>
          <div class="status-actions">
            <button v-for="status in issueStatuses" :key="status.value" class="status-action" :class="[`action-${status.value}`, { active: draft.status === status.value }]" type="button" @click="setStatus(status.value)">
              <span class="status-check">{{ draft.status === status.value ? '✓' : '' }}</span>{{ status.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="editor-footer"><span class="autosave-note"><span>&#9679;</span> &#20462;&#25913;&#33258;&#21160;&#20445;&#23384;&#21040;&#26381;&#21153;&#22120;</span><div class="editor-footer-actions"><button class="delete-issue-button" type="button" @click="openDeleteDialog">&#21024;&#38500;&#24847;&#35265;</button><button class="save-button" type="button" @click="commit">&#20445;&#23384;&#24847;&#35265;</button></div></div>
    </template>

    <Teleport to="body">
      <div v-if="deleteDialogOpen" class="issue-delete-backdrop">
        <section class="issue-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="issue-delete-title">
          <h2 id="issue-delete-title">&#21024;&#38500;&#36825;&#26465;&#26657;&#23545;&#24847;&#35265;&#65311;</h2>
          <p>PDF &#31532; {{ issue?.pdfPage }} &#39029;</p>
          <p v-if="issue?.originalText" class="issue-delete-quote">&#8220;{{ issue.originalText }}&#8221;</p>
          <p>&#20851;&#32852;&#30340; PDF &#26631;&#27880;&#20063;&#20250;&#19968;&#24182;&#21024;&#38500;&#12290;</p>
          <div class="issue-delete-actions">
            <button type="button" class="issue-delete-cancel" @click="closeDeleteDialog">&#21462;&#28040;</button>
            <button type="button" class="issue-delete-confirm" @click="confirmDelete">&#30830;&#35748;&#21024;&#38500;</button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.editor-panel { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.editor-heading { display: flex; align-items: center; justify-content: space-between; padding: 16px 17px 11px; }
.panel-kicker { color: #a1a9b7; font-size: 9px; font-weight: 700; letter-spacing: .13em; }
h2 { margin: 4px 0 0; color: #263149; font-size: 16px; }
.issue-id { color: #a1aab7; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; }
.editor-scroll { flex: 1; min-height: 0; padding: 0 17px 14px; overflow-y: auto; }
.form-grid { display: grid; gap: 10px; } .two-columns { grid-template-columns: 1fr 1fr; }
.form-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 11px; color: #68758b; font-size: 10px; font-weight: 600; }
.form-field em, .field-label-row em { margin-left: 3px; color: #adb5c0; font-size: 9px; font-style: normal; font-weight: 400; }
.form-field input, .form-field select, .form-field textarea { width: 100%; padding: 8px 9px; color: #38445a; font-size: 11px; font-weight: 400; background: #fbfcfd; border: 1px solid #e0e5eb; border-radius: 5px; outline: none; transition: border-color .15s, box-shadow .15s; }
.form-field input:focus, .form-field select:focus, .form-field textarea:focus { border-color: #9bb1cd; box-shadow: 0 0 0 3px rgba(89, 121, 164, .1); }
.form-field textarea { resize: vertical; line-height: 1.55; } .form-field input::placeholder, .form-field textarea::placeholder { color: #b4bbc6; }
.status-section { margin-top: 5px; padding-top: 13px; border-top: 1px solid #e9ecf0; }
.field-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: #68758b; font-size: 10px; font-weight: 600; }
.status-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.status-action { display: flex; align-items: center; gap: 6px; padding: 7px 8px; color: #8893a2; font-size: 10px; text-align: left; background: #fbfcfd; border: 1px solid #e4e8ed; border-radius: 5px; }
.status-action.active { color: #4d6d98; font-weight: 600; background: #f0f5fb; border-color: #afc2da; }
.status-check { display: grid; width: 14px; height: 14px; place-items: center; color: #fff; font-size: 9px; background: #d6dce4; border-radius: 50%; }
.active .status-check { background: #6081ac; }
.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 17px 14px; border-top: 1px solid #e3e7ed; }
.autosave-note { color: #9ba5b1; font-size: 9px; } .autosave-note span { color: #6db493; font-size: 8px; }
.save-button { padding: 7px 14px; color: #fff; font-size: 10px; background: #4e6f9d; border: 0; border-radius: 5px; } .save-button:hover { background: #405e87; }
.editor-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 7px; padding: 30px; color: #a1aab7; text-align: center; }
.editor-empty-icon { display: grid; width: 38px; height: 38px; margin-bottom: 4px; place-items: center; color: #7894b7; font-size: 17px; background: #eef4fb; border-radius: 50%; }
.editor-empty strong { color: #69778c; font-size: 11px; } .editor-empty span { max-width: 190px; font-size: 10px; line-height: 1.5; }

.editor-footer-actions { display: flex; align-items: center; gap: 8px; }
.delete-issue-button { padding: 7px 9px; color: #8b6870; font-size: 10px; background: transparent; border: 1px solid #eadfe2; border-radius: 5px; }
.delete-issue-button:hover { color: #8f4f59; background: #fff7f8; border-color: #d9b9bf; }
.issue-delete-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(23, 32, 51, .28); }
.issue-delete-dialog { width: min(360px, calc(100vw - 40px)); padding: 20px; color: #657188; background: #fff; border: 1px solid #dfe4eb; border-radius: 10px; box-shadow: 0 16px 40px rgba(23, 32, 51, .2); }
.issue-delete-dialog h2 { margin: 0 0 12px; font-size: 15px; }
.issue-delete-dialog p { margin: 7px 0; font-size: 11px; line-height: 1.5; }
.issue-delete-quote { color: #49566b; }
.issue-delete-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.issue-delete-cancel, .issue-delete-confirm { padding: 7px 12px; font-size: 10px; border-radius: 5px; }
.issue-delete-cancel { color: #68758b; background: #f6f8fa; border: 1px solid #dde3ea; }
.issue-delete-confirm { color: #fff; background: #8a5963; border: 1px solid #8a5963; }
</style>
