<script setup lang="ts">
import { computed, ref } from 'vue'
import { categoryLabelMap, statusLabelMap, type ProofreadingIssue } from '../models/proofreading'

const props = defineProps<{ issues: ProofreadingIssue[]; selectedIssueId: string | null }>()
const emit = defineEmits<{ select: [id: string]; create: [] }>()
const query = ref('')
const activeFilter = ref<'all' | 'pending' | 'done'>('all')

const filteredIssues = computed(() => {
  const normalizedQuery = query.value.trim().toLowerCase()
  return props.issues.filter((issue) => {
    const matchesQuery = !normalizedQuery || [issue.originalText, issue.suggestion, issue.reason, issue.printedPage]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery))
    const matchesFilter = activeFilter.value === 'all' ||
      (activeFilter.value === 'pending' && issue.status === 'pending') ||
      (activeFilter.value === 'done' && issue.status !== 'pending')
    return matchesQuery && matchesFilter
  })
})

function issuePreview(issue: ProofreadingIssue) { return issue.originalText || '未填写原文，点击编辑意见' }
</script>

<template>
  <section class="issue-list-panel">
    <div class="panel-heading">
      <div><span class="panel-kicker">REVIEW QUEUE</span><h2>校对意见 <span>{{ issues.length }}</span></h2></div>
      <button class="add-button" type="button" @click="emit('create')"><span>＋</span> 新增</button>
    </div>

    <div class="list-tools">
      <label class="search-box"><span aria-hidden="true">⌕</span><input v-model="query" type="search" placeholder="搜索原文或修改建议" /></label>
      <div class="filter-tabs" role="tablist" aria-label="意见筛选">
        <button :class="{ active: activeFilter === 'all' }" type="button" @click="activeFilter = 'all'">全部</button>
        <button :class="{ active: activeFilter === 'pending' }" type="button" @click="activeFilter = 'pending'">待处理</button>
        <button :class="{ active: activeFilter === 'done' }" type="button" @click="activeFilter = 'done'">已处理</button>
      </div>
    </div>

    <div class="issue-scroll">
      <button v-for="issue in filteredIssues" :key="issue.id" class="issue-card" :class="{ selected: selectedIssueId === issue.id }" type="button" @click="emit('select', issue.id)">
        <div class="issue-card-top">
          <span class="issue-number">#{{ String(issues.indexOf(issue) + 1).padStart(2, '0') }}</span>
          <span class="category-badge">{{ categoryLabelMap[issue.category] }}</span>
          <span class="status-badge" :class="`status-${issue.status}`">{{ statusLabelMap[issue.status] }}</span>
        </div>
        <p>{{ issuePreview(issue) }}</p>
        <div class="issue-card-meta"><span>PDF {{ issue.pdfPage }} 页</span><span v-if="issue.printedPage">书中 {{ issue.printedPage }} 页</span><span class="issue-chevron">›</span></div>
      </button>

      <div v-if="filteredIssues.length === 0" class="empty-state">
        <div class="empty-icon">✓</div>
        <strong>{{ issues.length ? '没有匹配的意见' : '还没有校对意见' }}</strong>
        <span>{{ issues.length ? '试试其他关键词或筛选条件' : '在 PDF 中高亮文字，或点击“新增”' }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.issue-list-panel { display: flex; flex: 0 0 46%; flex-direction: column; min-height: 280px; border-bottom: 1px solid #e0e5ec; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; padding: 18px 17px 13px; }
.panel-kicker { color: #9aa4b4; font-size: 9px; font-weight: 700; letter-spacing: .13em; }
h2 { margin: 4px 0 0; color: #263149; font-size: 17px; }
h2 span { display: inline-grid; min-width: 22px; height: 18px; margin-left: 3px; padding: 0 5px; place-items: center; color: #718096; font-size: 10px; font-weight: 600; vertical-align: middle; background: #edf0f4; border-radius: 9px; }
.add-button { padding: 7px 10px; color: #46658f; font-size: 11px; background: #f1f5fa; border: 1px solid #d8e2ee; border-radius: 6px; }
.add-button:hover { background: #e7eef8; }
.list-tools { padding: 0 17px 11px; }
.search-box { display: flex; align-items: center; gap: 7px; padding: 7px 9px; color: #9aa5b6; background: #f6f8fa; border: 1px solid #e4e8ee; border-radius: 6px; }
.search-box input { width: 100%; color: #3c4860; font-size: 11px; background: transparent; border: 0; outline: 0; }
.search-box input::placeholder { color: #abb4c1; }
.filter-tabs { display: flex; gap: 15px; margin-top: 10px; }
.filter-tabs button { padding: 0 0 5px; color: #98a2b1; font-size: 10px; background: none; border: 0; border-bottom: 2px solid transparent; }
.filter-tabs button.active { color: #49678f; border-bottom-color: #49678f; }
.issue-scroll { flex: 1; min-height: 0; padding: 0 10px 14px; overflow-y: auto; }
.issue-card { display: block; width: 100%; margin-bottom: 7px; padding: 11px 10px 9px; text-align: left; background: #fff; border: 1px solid #e8ebf0; border-radius: 7px; }
.issue-card:hover { border-color: #cbd8e8; box-shadow: 0 3px 10px rgba(55, 77, 107, .06); }
.issue-card.selected { background: #f5f8fc; border-color: #9bb1cd; box-shadow: inset 3px 0 #55749d; }
.issue-card-top { display: flex; align-items: center; gap: 6px; }
.issue-number { color: #9ba5b4; font-size: 9px; font-weight: 700; }
.category-badge, .status-badge { padding: 3px 6px; font-size: 9px; border-radius: 4px; }
.category-badge { color: #62718a; background: #edf1f6; } .status-badge { margin-left: auto; }
.status-pending { color: #9a7131; background: #fbf2dd; } .status-confirmed { color: #4d7397; background: #e8f1fa; } .status-revised { color: #4e806e; background: #e5f3ed; } .status-reviewed { color: #6c668d; background: #eeeafa; }
.issue-card p { display: -webkit-box; margin: 9px 0 8px; overflow: hidden; color: #344159; font-size: 11px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.issue-card-meta { display: flex; align-items: center; gap: 9px; color: #9aa4b3; font-size: 9px; }
.issue-chevron { margin-left: auto; color: #9ca8b8; font-size: 16px; line-height: 10px; }
.empty-state { display: flex; flex-direction: column; gap: 6px; align-items: center; padding: 34px 20px; color: #9da7b5; text-align: center; }
.empty-icon { display: grid; width: 34px; height: 34px; margin-bottom: 3px; place-items: center; color: #7693b7; font-size: 17px; background: #edf3fa; border-radius: 50%; }
.empty-state strong { color: #6e7c91; font-size: 11px; } .empty-state span { font-size: 10px; }
</style>

