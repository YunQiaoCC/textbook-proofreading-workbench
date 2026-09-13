<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { issueCategories, type ProofreadingIssue, type ProofreadingIssuePatch } from '../models/proofreading'
const props = defineProps<{ issue: ProofreadingIssue | null; reviewerName?: string; readOnly: boolean }>()
const emit = defineEmits<{ update: [id: string, patch: ProofreadingIssuePatch]; delete: [id: string] }>()
const draft = reactive<ProofreadingIssue>({ id:'',annotationId:'',pdfPage:1,printedPage:'',originalText:'',category:'other',suggestion:'',reason:'',status:'confirmed',reviewer:'',verifier:'',createdAt:'',updatedAt:'' })
const deleteDialogOpen = ref(false)
watch(() => props.issue, (issue) => { if (issue) Object.assign(draft, issue) }, { immediate: true })
function commit(){if(!props.issue||props.readOnly)return;emit('update',props.issue.id,{pdfPage:Number(draft.pdfPage)||1,printedPage:draft.printedPage,originalText:draft.originalText,category:draft.category,suggestion:draft.suggestion,reason:draft.reason})}
</script>
<template>
  <section class="editor-panel">
    <div v-if="!issue" class="editor-empty"><div class="editor-empty-icon">✎</div><strong>选择一条人工补充意见</strong><span>人工复审人可独立检查本章并补充 AI 遗漏</span></div>
    <template v-else>
      <div class="editor-heading"><div><span class="panel-kicker">HUMAN ISSUE</span><h2>人工补充详情</h2></div><span class="issue-id">{{ issue.id.replace('issue-', '#') }}</span></div>
      <div class="editor-scroll">
        <div class="source-summary"><span>来源：<strong>👤 人工补充</strong></span><span>人工复审人：<strong>{{ reviewerName || issue.reviewer || '未指定' }}</strong></span></div>
        <div class="form-grid two-columns"><label class="form-field"><span>PDF 页码</span><input v-model.number="draft.pdfPage" min="1" type="number" :disabled="readOnly" @blur="commit" /></label><label class="form-field"><span>书中页码</span><input v-model="draft.printedPage" placeholder="如：12" :disabled="readOnly" @blur="commit" /></label></div>
        <label class="form-field"><span>原文</span><textarea v-model="draft.originalText" rows="3" :disabled="readOnly" placeholder="输入需要校对的原文" @blur="commit" /></label>
        <label class="form-field"><span>问题类型</span><select v-model="draft.category" :disabled="readOnly" @change="commit"><option v-for="category in issueCategories" :key="category.value" :value="category.value">{{ category.label }}</option></select></label>
        <label class="form-field"><span>修改建议</span><textarea v-model="draft.suggestion" rows="3" :disabled="readOnly" placeholder="填写建议修改后的内容" @blur="commit" /></label>
        <label class="form-field"><span>修改理由 <em>可选</em></span><textarea v-model="draft.reason" rows="3" :disabled="readOnly" placeholder="说明依据、规则或判断理由" @blur="commit" /></label>
      </div>
      <div class="editor-footer"><span class="autosave-note">{{ readOnly ? '本章已完成，意见只读' : '● 修改自动保存到服务器' }}</span><div v-if="!readOnly" class="editor-footer-actions"><button class="delete-issue-button" type="button" @click="deleteDialogOpen=true">删除意见</button><button class="save-button" type="button" @click="commit">保存意见</button></div></div>
    </template>
    <Teleport to="body"><div v-if="deleteDialogOpen" class="issue-delete-backdrop"><section class="issue-delete-dialog" role="dialog" aria-modal="true"><h2>删除这条校对意见？</h2><p>关联的 PDF 标注也会一并删除。</p><div class="issue-delete-actions"><button type="button" @click="deleteDialogOpen=false">取消</button><button class="danger" type="button" @click="issue&&(emit('delete',issue.id),deleteDialogOpen=false)">确认删除</button></div></section></div></Teleport>
  </section>
</template>
<style scoped>
.editor-panel{display:flex;flex:1;flex-direction:column;min-height:0}.editor-heading{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px}.panel-kicker{color:#a1a9b7;font-size:8px;font-weight:700;letter-spacing:.13em}h2{margin:3px 0 0;color:#263149;font-size:15px}.issue-id{color:#a1aab7;font:9px ui-monospace,monospace}.editor-scroll{flex:1;min-height:0;padding:0 16px 12px;overflow-y:auto}.source-summary{display:flex;justify-content:space-between;gap:8px;margin-bottom:11px;padding:8px 9px;color:#7a879a;font-size:9px;background:#f4f7fa;border-radius:6px}.source-summary strong{color:#4b607d}.form-grid{display:grid;gap:10px}.two-columns{grid-template-columns:1fr 1fr}.form-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;color:#68758b;font-size:10px;font-weight:600}.form-field em{color:#adb5c0;font-size:9px;font-style:normal;font-weight:400}.form-field input,.form-field select,.form-field textarea{width:100%;padding:7px 8px;color:#38445a;font-size:10px;font-weight:400;background:#fbfcfd;border:1px solid #e0e5eb;border-radius:5px;outline:none}.form-field :disabled{color:#68758b;background:#f2f4f7;cursor:not-allowed}.form-field textarea{resize:vertical;line-height:1.5}.editor-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 16px 12px;border-top:1px solid #e3e7ed}.autosave-note{color:#8d9aa9;font-size:9px}.editor-footer-actions{display:flex;gap:7px}.editor-footer button{padding:6px 9px;font-size:9px;border-radius:5px}.delete-issue-button{color:#8b6870;background:transparent;border:1px solid #eadfe2}.save-button{color:#fff;background:#4e6f9d;border:0}.editor-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:25px;color:#a1aab7;text-align:center}.editor-empty-icon{display:grid;width:36px;height:36px;place-items:center;color:#7894b7;background:#eef4fb;border-radius:50%}.editor-empty strong{color:#69778c;font-size:11px}.editor-empty span{max-width:210px;font-size:9px;line-height:1.5}.issue-delete-backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:rgba(23,32,51,.28)}.issue-delete-dialog{width:340px;padding:20px;color:#657188;background:#fff;border-radius:10px;box-shadow:0 16px 40px rgba(23,32,51,.2)}.issue-delete-dialog h2{margin:0 0 10px}.issue-delete-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:17px}.issue-delete-actions button{padding:7px 12px;border:1px solid #d6dfe9;border-radius:5px}.issue-delete-actions .danger{color:#fff;background:#8a5963;border-color:#8a5963}
</style>
