<script setup lang="ts">
import { computed, ref } from 'vue'
import { aiCandidateResolutionLabelMap, aiIssueTypeLabelMap } from '../models/aiReview'
import { categoryLabelMap } from '../models/proofreading'
import type { ReviewQueueItem } from '../models/reviewQueue'

const props = defineProps<{ items: ReviewQueueItem[]; selectedKey: string | null; readOnly: boolean }>()
const emit = defineEmits<{ select: [key: string]; create: [] }>()
const query = ref('')
const activeFilter = ref<'all' | 'ai' | 'human'>('all')

const filteredItems = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase()
  return props.items.filter((item) => {
    if (activeFilter.value !== 'all' && item.source !== activeFilter.value) return false
    const value = item.source === 'ai' ? item.entry.candidate : item.issue
    const modified = item.source === 'ai' ? item.entry.resolution.modifiedResult : undefined
    const printedPage = item.source === 'human' ? item.issue.printedPage : undefined
    return !normalizedQuery || [value.originalText, value.suggestion, value.reason, printedPage, value.pdfPage, modified?.originalText, modified?.suggestion, modified?.reason, modified?.printedPage, modified?.pdfPage]
      .filter((entry) => entry !== undefined).some((entry) => String(entry).toLowerCase().includes(normalizedQuery))
  })
})

function preview(item: ReviewQueueItem) {
  return item.source === 'ai' ? item.entry.candidate.originalText : item.issue.originalText || '未填写原文，点击编辑意见'
}
</script>

<template>
  <section class="issue-list-panel">
    <div class="panel-heading">
      <div><span class="panel-kicker">REVIEW QUEUE</span><h2>校对意见 <span>{{ items.length }}</span></h2></div>
      <button class="add-button" type="button" :disabled="readOnly" :title="readOnly ? '本章复审已完成' : '人工主动补充问题'" @click="emit('create')"><span>＋</span> 新增</button>
    </div>
    <div class="list-tools">
      <label class="search-box"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索原文、建议、理由或页码" /></label>
      <div class="filter-tabs" role="tablist" aria-label="意见来源筛选">
        <button :class="{ active: activeFilter === 'all' }" type="button" @click="activeFilter = 'all'">全部</button>
        <button :class="{ active: activeFilter === 'ai' }" type="button" @click="activeFilter = 'ai'">AI 初校</button>
        <button :class="{ active: activeFilter === 'human' }" type="button" @click="activeFilter = 'human'">人工补充</button>
      </div>
    </div>
    <div class="issue-scroll">
      <button v-for="(item, index) in filteredItems" :key="item.key" class="issue-card" :class="[{ selected: selectedKey === item.key }, `source-${item.source}`]" type="button" @click="emit('select', item.key)">
        <div class="issue-card-top">
          <span class="issue-number">#{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="source-badge" :class="item.source">{{ item.source === 'ai' ? '✦ AI 初校' : '👤 人工补充' }}</span>
          <span class="category-badge">{{ item.source === 'ai' ? aiIssueTypeLabelMap[item.entry.candidate.issueType] : categoryLabelMap[item.issue.category] }}</span>
          <span v-if="item.source === 'ai'" class="status-badge" :class="`status-${item.entry.resolution.status}`">{{ aiCandidateResolutionLabelMap[item.entry.resolution.status] }}</span>
        </div>
        <p :class="{ muted: item.source === 'ai' && item.entry.resolution.status === 'rejected' }">{{ preview(item) }}</p>
        <div class="issue-card-meta"><span>PDF {{ item.source === 'ai' ? item.entry.candidate.pdfPage : item.issue.pdfPage }} 页</span><span v-if="item.source === 'human' && item.issue.printedPage">书中 {{ item.issue.printedPage }} 页</span><span class="issue-chevron">›</span></div>
      </button>
      <div v-if="filteredItems.length === 0" class="empty-state"><div class="empty-icon">✓</div><strong>{{ items.length ? '没有匹配的意见' : '还没有校对意见' }}</strong><span>{{ items.length ? '试试其他关键词或来源筛选' : '可继续完整检查本章并主动补充遗漏' }}</span></div>
    </div>
  </section>
</template>

<style scoped>
.issue-list-panel{display:flex;flex:0 0 39%;flex-direction:column;min-height:245px;border-bottom:1px solid #e0e5ec}.panel-heading{display:flex;align-items:center;justify-content:space-between;padding:13px 15px 10px}.panel-kicker{color:#9aa4b4;font-size:8px;font-weight:700;letter-spacing:.13em}h2{margin:3px 0 0;color:#263149;font-size:15px}h2 span{display:inline-grid;min-width:21px;height:17px;margin-left:3px;padding:0 5px;place-items:center;color:#718096;font-size:9px;background:#edf0f4;border-radius:9px}.add-button{padding:6px 9px;color:#46658f;font-size:10px;background:#f1f5fa;border:1px solid #d8e2ee;border-radius:6px}.add-button:disabled{cursor:not-allowed;opacity:.48}.list-tools{padding:0 15px 9px}.search-box{display:flex;align-items:center;gap:7px;padding:6px 8px;color:#9aa5b6;background:#f6f8fa;border:1px solid #e4e8ee;border-radius:6px}.search-box input{width:100%;color:#3c4860;font-size:10px;background:transparent;border:0;outline:0}.filter-tabs{display:flex;gap:15px;margin-top:8px}.filter-tabs button{padding:0 0 4px;color:#98a2b1;font-size:10px;background:none;border:0;border-bottom:2px solid transparent}.filter-tabs button.active{color:#49678f;border-bottom-color:#49678f}.issue-scroll{flex:1;min-height:0;padding:0 9px 10px;overflow-y:auto}.issue-card{display:block;width:100%;margin-bottom:6px;padding:9px;text-align:left;background:#fff;border:1px solid #e8ebf0;border-radius:7px}.issue-card:hover,.issue-card.selected{border-color:#a9bad0}.issue-card.selected{background:#f5f8fc;box-shadow:inset 3px 0 #55749d}.issue-card-top{display:flex;align-items:center;gap:5px}.issue-number{color:#9ba5b4;font-size:8px;font-weight:700}.source-badge,.category-badge,.status-badge{padding:3px 5px;font-size:8px;border-radius:4px}.source-badge.ai{color:#806329;background:#f7eedc}.source-badge.human{color:#4c6e94;background:#e9f0f8}.category-badge{color:#62718a;background:#edf1f6}.status-badge{margin-left:auto}.status-pending{color:#9a7131;background:#fbf2dd}.status-accepted{color:#4d7397;background:#e8f1fa}.status-modified{color:#4e806e;background:#e5f3ed}.status-rejected{color:#7f7580;background:#efedf0}.issue-card p{display:-webkit-box;margin:7px 0;overflow:hidden;color:#344159;font-size:10px;line-height:1.45;-webkit-box-orient:vertical;-webkit-line-clamp:2}.issue-card p.muted{color:#8f98a6;text-decoration:line-through;text-decoration-color:#c5cad1}.issue-card-meta{display:flex;align-items:center;gap:9px;color:#9aa4b3;font-size:8px}.issue-chevron{margin-left:auto;font-size:15px;line-height:9px}.empty-state{display:flex;flex-direction:column;gap:6px;align-items:center;padding:25px 18px;color:#9da7b5;text-align:center}.empty-icon{display:grid;width:31px;height:31px;place-items:center;color:#7693b7;background:#edf3fa;border-radius:50%}.empty-state strong{color:#6e7c91;font-size:10px}.empty-state span{font-size:9px}
</style>
