<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { aiOverlayPercentRect, aiOverlayTone } from '../../shared/aiCandidateOverlay.js'
import type { AiCandidateOverlay } from '../models/aiReview'

const props = defineProps<{
  host: HTMLElement | null
  overlays: AiCandidateOverlay[]
  visible: boolean
  activeCandidateId: string | null
}>()
const emit = defineEmits<{ select: [candidateId: string] }>()

const OWNED_LAYER_SELECTOR = '.ai-candidate-overlay-layer[data-ai-overlay-owned="true"]'
let mutationObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null
let frameRequest = 0
let flashTimer: ReturnType<typeof setTimeout> | null = null

function pageElement(pdfPage: number) {
  return props.host?.querySelector<HTMLElement>(`.page[data-page-number="${pdfPage}"]`) ?? null
}

function overlayButton(candidateId: string) {
  if (!props.host) return null
  return [...props.host.querySelectorAll<HTMLButtonElement>('.ai-candidate-overlay')]
    .find((button) => button.dataset.candidateId === candidateId) ?? null
}

function positionLayer(page: HTMLElement, layer: HTMLElement) {
  const canvas = page.querySelector<HTMLElement>('.canvasWrapper') ?? page.querySelector<HTMLElement>('canvas')
  if (!canvas) return false
  const pageRect = page.getBoundingClientRect()
  const canvasRect = canvas.getBoundingClientRect()
  if (canvasRect.width <= 0 || canvasRect.height <= 0) return false
  layer.style.left = `${canvasRect.left - pageRect.left}px`
  layer.style.top = `${canvasRect.top - pageRect.top}px`
  layer.style.width = `${canvasRect.width}px`
  layer.style.height = `${canvasRect.height}px`
  resizeObserver?.observe(page)
  resizeObserver?.observe(canvas)
  return true
}

function layerForPage(page: HTMLElement) {
  let layer = page.querySelector<HTMLElement>(`:scope > ${OWNED_LAYER_SELECTOR}`)
  if (!layer) {
    layer = document.createElement('div')
    layer.className = 'ai-candidate-overlay-layer'
    layer.dataset.aiOverlayOwned = 'true'
    layer.setAttribute('aria-label', 'AI 初校标记')
    page.append(layer)
  }
  return layer
}

function createButton(overlay: AiCandidateOverlay) {
  const rect = aiOverlayPercentRect(overlay)
  if (!rect) return null
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `ai-candidate-overlay is-${aiOverlayTone(overlay.resolutionStatus)}`
  button.dataset.candidateId = overlay.candidateId
  button.dataset.overlayId = overlay.id
  button.setAttribute('aria-label', `定位 AI 初校意见，PDF 第 ${overlay.pdfPage} 页`)
  button.title = `✦ AI · ${overlay.issueType} · ${overlay.resolutionStatus}`
  Object.assign(button.style, rect)
  const marker = document.createElement('span')
  marker.textContent = '✦ AI'
  marker.setAttribute('aria-hidden', 'true')
  button.append(marker)
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    emit('select', overlay.candidateId)
  })
  return button
}

function sync() {
  frameRequest = 0
  if (!props.host) return
  const overlaysByPage = new Map<number, AiCandidateOverlay[]>()
  if (props.visible) {
    for (const overlay of props.overlays) {
      const pageOverlays = overlaysByPage.get(overlay.pdfPage) ?? []
      pageOverlays.push(overlay)
      overlaysByPage.set(overlay.pdfPage, pageOverlays)
    }
  }

  for (const layer of props.host.querySelectorAll<HTMLElement>(OWNED_LAYER_SELECTOR)) {
    const page = layer.closest<HTMLElement>('.page[data-page-number]')
    const pdfPage = Number(page?.dataset.pageNumber)
    if (!page || !overlaysByPage.has(pdfPage) || !positionLayer(page, layer)) layer.remove()
    else layer.replaceChildren()
  }

  for (const [pdfPage, overlays] of overlaysByPage) {
    const page = pageElement(pdfPage)
    if (!page) continue
    const layer = layerForPage(page)
    if (!positionLayer(page, layer)) {
      layer.remove()
      continue
    }
    for (const overlay of overlays) {
      const button = createButton(overlay)
      if (button) layer.append(button)
    }
  }
  applySelection()
}

function scheduleSync() {
  if (frameRequest || typeof requestAnimationFrame === 'undefined') {
    if (!frameRequest) sync()
    return
  }
  frameRequest = requestAnimationFrame(sync)
}

function applySelection() {
  if (!props.host) return
  for (const button of props.host.querySelectorAll<HTMLButtonElement>('.ai-candidate-overlay')) {
    button.classList.toggle('is-selected', button.dataset.candidateId === props.activeCandidateId)
  }
}

function observeHost(host: HTMLElement | null) {
  mutationObserver?.disconnect()
  resizeObserver?.disconnect()
  mutationObserver = null
  resizeObserver = null
  if (!host) return
  resizeObserver = new ResizeObserver(scheduleSync)
  resizeObserver.observe(host)
  mutationObserver = new MutationObserver((mutations) => {
    const externalChange = mutations.some((mutation) =>
      !(mutation.target instanceof Element && mutation.target.closest(OWNED_LAYER_SELECTOR)),
    )
    if (externalChange) scheduleSync()
  })
  mutationObserver.observe(host, { childList: true, subtree: true })
  scheduleSync()
}

function refresh() {
  scheduleSync()
}

async function focusCandidate(candidateId: string, fallbackPdfPage?: number) {
  const overlay = props.overlays.find((value) => value.candidateId === candidateId)
  const pdfPage = overlay?.pdfPage ?? fallbackPdfPage
  if (!pdfPage) return false
  await nextTick()
  scheduleSync()
  if (typeof requestAnimationFrame !== 'undefined') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  const page = pageElement(pdfPage)
  page?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  if (!overlay || !props.visible) return Boolean(page)
  const button = overlayButton(candidateId)
  if (!button) return Boolean(page)
  button.focus({ preventScroll: true })
  button.classList.add('is-flashing')
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => button.classList.remove('is-flashing'), 1400)
  return true
}

watch(() => props.host, observeHost, { immediate: true })
watch(() => [props.visible, props.overlays], scheduleSync, { deep: true })
watch(() => props.activeCandidateId, applySelection)
onMounted(scheduleSync)
onBeforeUnmount(() => {
  mutationObserver?.disconnect()
  resizeObserver?.disconnect()
  if (frameRequest) cancelAnimationFrame(frameRequest)
  if (flashTimer) clearTimeout(flashTimer)
  props.host?.querySelectorAll(OWNED_LAYER_SELECTOR).forEach((layer) => layer.remove())
})

defineExpose({ refresh, focusCandidate })
</script>

<template><span class="ai-overlay-controller" hidden /></template>

<style>
.ai-candidate-overlay-layer{position:absolute;z-index:28;overflow:visible;pointer-events:none}
.ai-candidate-overlay{position:absolute;min-width:9px;min-height:7px;padding:0;overflow:visible;background:rgba(224,180,72,.28);border:1px solid rgba(173,125,22,.5);border-radius:2px;box-shadow:0 0 0 1px rgba(255,255,255,.2) inset;pointer-events:none;transition:background .15s,border-color .15s,box-shadow .15s}
.ai-candidate-overlay.is-accepted{background:rgba(89,184,127,.22);border-color:rgba(46,135,82,.5)}
.ai-candidate-overlay.is-modified{background:rgba(76,153,217,.22);border-color:rgba(39,112,178,.52)}
.ai-candidate-overlay>span{position:absolute;top:-15px;left:-1px;padding:1px 4px;color:#745314;font-size:8px;font-weight:800;line-height:12px;white-space:nowrap;background:#fff5d9;border:1px solid rgba(173,125,22,.45);border-radius:3px;box-shadow:0 1px 3px rgba(44,50,63,.14);cursor:pointer;pointer-events:auto}
.ai-candidate-overlay.is-accepted>span{color:#276544;background:#e8f7ee;border-color:rgba(46,135,82,.42)}
.ai-candidate-overlay.is-modified>span{color:#275f91;background:#eaf4fc;border-color:rgba(39,112,178,.42)}
.ai-candidate-overlay:hover,.ai-candidate-overlay:focus-visible,.ai-candidate-overlay.is-selected{outline:0;border-color:#4f6485;box-shadow:0 0 0 2px rgba(255,255,255,.92),0 0 0 4px rgba(79,100,133,.68)}
.ai-candidate-overlay.is-flashing{animation:ai-overlay-flash .7s ease-in-out 2}
@keyframes ai-overlay-flash{50%{filter:brightness(1.16);box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 0 6px rgba(71,99,142,.82)}}
</style>
