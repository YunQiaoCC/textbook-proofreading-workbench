<script setup lang="ts">
import type { Annotation } from 'inklayer-vue'

defineProps<{
  save: () => void
  getAnnotations: () => Annotation[]
  exportToExcel: (fileName?: string) => void
  exportToPdf: (fileName?: string) => Promise<void>
}>()
</script>

<template>
  <div class="inklayer-actions" title="InkLayer 导出">
    <button type="button" @click="exportToExcel('inklayer-annotations.xlsx')">批注 Excel</button>
    <button type="button" @click="exportToPdf('inklayer-annotated.pdf')">批注 PDF</button>
  </div>
</template>

<style scoped>
.inklayer-actions { display: inline-flex; gap: 4px; align-items: center; margin-left: 8px; }
.inklayer-actions button { padding: 4px 6px; color: #536276; font-size: 10px; background: transparent; border: 1px solid #dfe4ea; border-radius: 4px; }
.inklayer-actions button:hover { color: #38577f; background: #f1f5fa; }
</style>

