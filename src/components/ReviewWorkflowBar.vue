<script setup lang="ts">
import { computed } from 'vue'
import type { AiReviewWorkspace, AiRuntimeStatus } from '../models/aiReview'

const props = defineProps<{ workspace: AiReviewWorkspace | null; runtimeStatus: AiRuntimeStatus | null; assigneeName?: string; manualCount: number; loading: boolean; acting: boolean; error: string; conflict: boolean }>()
const emit = defineEmits<{ run: []; start: []; complete: []; reload: [] }>()
const counts = computed(() => {
  const entries = props.workspace?.candidates ?? []
  return { total: entries.length, pending: entries.filter((entry) => entry.resolution.status === 'pending').length, accepted: entries.filter((entry) => entry.resolution.status === 'accepted').length, modified: entries.filter((entry) => entry.resolution.status === 'modified').length, rejected: entries.filter((entry) => entry.resolution.status === 'rejected').length }
})
const stage = computed(() => props.workspace?.stage ?? 'awaiting_ai')
const step = computed(() => stage.value === 'completed' ? 3 : ['awaiting_human_review','human_review_in_progress'].includes(stage.value) ? 2 : 1)
const coverage = computed(() => props.workspace?.aiRun.coverage)
const coverageMissing = computed(() => (coverage.value?.suspiciousPages ?? 0) + (coverage.value?.unavailablePages ?? 0))
</script>
<template>
  <section class="workflow-bar" aria-label="章节复审流程">
    <div class="workflow-top"><div class="steps"><span :class="{active:step>=1}">AI 初校</span><b>→</b><span :class="{active:step>=2}">人工复审</span><b>→</b><span :class="{active:step>=3}">完成</span></div><span class="reviewer">人工复审人：{{ assigneeName || '未指定' }}</span></div>
    <div v-if="loading" class="stage-note">正在读取 AI 复审进度…</div>
    <template v-else>
      <div v-if="stage==='awaiting_ai'" class="stage-action"><p><strong>{{ runtimeStatus?.configured?'等待 AI 初校':'AI 初校暂不可用' }}</strong><span>{{ runtimeStatus?.configured?'人工意见仍可查看和补充。':'模型服务尚未配置' }}</span></p><button type="button" :disabled="acting||!runtimeStatus?.configured" @click="emit('run')">开始 AI 初校</button></div>
      <div v-else-if="stage==='ai_running'" class="stage-note"><strong>AI 初校进行中</strong><span>人工补充功能仍可使用。</span></div>
      <div v-else-if="stage==='ai_failed'" class="stage-action error-stage"><p><strong>AI 初校失败</strong><span>{{ workspace?.aiRun.errorCode==='runtime_interrupted'?'服务运行期间中断，请重新执行 AI 初校。':'人工意见仍可正常使用。' }}</span></p><button type="button" :disabled="acting||!runtimeStatus?.configured" @click="emit('run')">重试 AI 初校</button></div>
      <div v-else-if="stage==='awaiting_human_review'" class="stage-action" :class="{'coverage-warning':coverage&&!coverage.complete}"><p><strong>{{ coverage&&!coverage.complete?'AI 初校已完成 · 部分页面需人工重点检查':'AI 初校已完成' }}</strong><span>{{ coverage&&!coverage.complete?`${coverageMissing} 页文本提取不完整，人工复审时请重点核查。`:'开始后，请在核查 AI 建议的同时完整检查本章并补充遗漏。' }}</span></p><button type="button" :disabled="acting||!assigneeName" @click="emit('start')">开始人工复审</button></div>
      <div v-else-if="stage==='human_review_in_progress'" class="progress-content"><div class="stats"><span>AI 建议 <b>{{ counts.total }}</b></span><span>待复审 <b>{{ counts.pending }}</b></span><span>已接受 <b>{{ counts.accepted }}</b></span><span>已修改 <b>{{ counts.modified }}</b></span><span>已驳回 <b>{{ counts.rejected }}</b></span><span>人工补充 <b>{{ manualCount }}</b></span></div><div class="complete-row"><span>{{ counts.pending ? `还有 ${counts.pending} 条 AI 建议待复审` : '所有 AI 建议已处理，请确认已完整检查本章。' }}</span><button type="button" :disabled="acting||counts.pending>0||!assigneeName" @click="emit('complete')">完成本章复审</button></div></div>
      <div v-else class="completed-note">✓ 本章复审已完成</div>
      <div v-if="!assigneeName && stage!=='completed'" class="assignee-warning">请先指定本章人工复审负责人</div>
      <div v-if="error" class="workflow-error"><span>{{ error }}</span><button v-if="conflict" type="button" @click="emit('reload')">重新加载</button></div>
    </template>
  </section>
</template>
<style scoped>
.workflow-bar{padding:11px 14px;color:#56657b;background:#f8f9fb;border-bottom:1px solid #e0e5ec}.workflow-top,.stage-action,.complete-row,.workflow-error{display:flex;align-items:center;justify-content:space-between;gap:10px}.steps{display:flex;align-items:center;gap:6px;color:#a2aab6;font-size:9px;font-weight:700}.steps span{padding:4px 6px;border-radius:4px}.steps span.active{color:#4c6589;background:#e9eef5}.steps b{color:#c0c6cf;font-weight:400}.reviewer{color:#7f8b9c;font-size:9px}.stage-note{display:flex;align-items:baseline;gap:8px;margin-top:9px;font-size:9px}.stage-note strong{color:#3d4e68;font-size:10px}.stage-note span,.stage-action span{color:#8994a4}.error-stage strong{color:#9c5555}.stage-action{margin-top:9px}.stage-action p{display:flex;flex-direction:column;gap:3px;margin:0;font-size:9px}.stage-action strong{color:#40536f;font-size:10px}.stage-action button,.complete-row button{padding:6px 9px;color:#fff;font-size:9px;background:#4d6d99;border:0;border-radius:5px}.stage-action button:disabled,.complete-row button:disabled{cursor:not-allowed;opacity:.45}.progress-content{margin-top:9px}.stats{display:flex;flex-wrap:wrap;gap:5px}.stats span{padding:4px 6px;color:#738094;font-size:8px;background:#eef1f5;border-radius:4px}.stats b{color:#3f587a}.complete-row{margin-top:8px;color:#8a7460;font-size:9px}.completed-note{margin-top:9px;color:#3f7b66;font-size:11px;font-weight:700}.assignee-warning{margin-top:7px;color:#9b6a45;font-size:9px}.workflow-error{margin-top:7px;padding:6px 7px;color:#a05050;font-size:9px;background:#fff0ee;border-radius:4px}.workflow-error button{padding:0;color:#83506b;background:transparent;border:0;text-decoration:underline}
.coverage-warning{padding:7px;background:#fff8e8;border-radius:6px}
</style>
