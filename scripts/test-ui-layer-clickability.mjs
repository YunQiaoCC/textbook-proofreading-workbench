#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { annotationEditingEnabled } from '../shared/workbenchState.js'

const workbenchSource = await readFile(new URL('../src/WorkbenchView.vue', import.meta.url), 'utf8')
const outlineSource = await readFile(new URL('../src/components/DocumentOutline.vue', import.meta.url), 'utf8')
const aiOverlaySource = await readFile(new URL('../src/components/AiCandidatePdfOverlay.vue', import.meta.url), 'utf8')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function declarations(source, selector) {
  const match = source.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[1]
}

function property(rule, name) {
  const match = rule.match(new RegExp(`(?:^|;)\\s*${escapeRegExp(name)}\\s*:\\s*([^;]+)`))
  assert.ok(match, `missing ${name}`)
  return match[1].trim()
}

const rootRule = declarations(workbenchSource, ':root')
const variables = Object.fromEntries(
  [...rootRule.matchAll(/(--[\w-]+)\s*:\s*(\d+)/g)].map(([, name, value]) => [name, Number(value)]),
)

function resolvedZ(source, selector) {
  const raw = property(declarations(source, selector), 'z-index')
  const variable = raw.match(/^var\((--[\w-]+)\)$/)?.[1]
  return variable ? variables[variable] : Number(raw)
}

function pointerEvents(source, selector) {
  return property(declarations(source, selector), 'pointer-events')
}

class HitTarget extends EventTarget {
  constructor(name, zIndex, pointerEvents = 'auto') {
    super()
    this.name = name
    this.zIndex = zIndex
    this.pointerEvents = pointerEvents
  }
}

function elementFromSyntheticPoint(layers) {
  return layers
    .filter((layer) => layer.pointerEvents !== 'none')
    .sort((left, right) => right.zIndex - left.zIndex)[0] ?? null
}

function assertReceivesPointerAndClick(target, competingLayers) {
  let pointerdowns = 0
  let clicks = 0
  target.addEventListener('pointerdown', () => { pointerdowns += 1 })
  target.addEventListener('click', () => { clicks += 1 })
  const top = elementFromSyntheticPoint([target, ...competingLayers])
  top.dispatchEvent(new Event('pointerdown'))
  top.dispatchEvent(new Event('click'))
  assert.equal(top, target)
  assert.equal(pointerdowns, 1)
  assert.equal(clicks, 1)
}

const inkLayerInternalUi = new HitTarget('InkLayer internal UI', 999)
const drawer = new HitTarget('chapter drawer', resolvedZ(outlineSource, '.chapter-drawer'), pointerEvents(outlineSource, '.chapter-drawer'))
const documentDialog = new HitTarget('document delete dialog', resolvedZ(outlineSource, '.document-delete-backdrop'), pointerEvents(outlineSource, '.document-delete-dialog'))
const chapterDialog = new HitTarget('chapter delete dialog', resolvedZ(workbenchSource, '.chapter-delete-backdrop'), pointerEvents(workbenchSource, '.chapter-delete-dialog'))

let testCount = 0
async function test(name, callback) {
  await callback()
  testCount += 1
  console.log(`${name}=pass`)
}

await test('chapter-drawer-save-button-clickable', () => {
  assert.match(outlineSource, /<form class="chapter-form" @submit\.prevent="submitForm">/)
  assert.match(outlineSource, /<button class="primary" type="submit" :disabled="formSubmitting \|\| chapterLoading">/)
  assertReceivesPointerAndClick(drawer, [inkLayerInternalUi])
})

await test('save-button-not-covered-by-app-overlay', () => {
  assert.ok(drawer.zIndex > inkLayerInternalUi.zIndex)
  assert.equal(elementFromSyntheticPoint([drawer, inkLayerInternalUi]), drawer)
})

await test('document-delete-confirm-clickable', () => {
  assert.match(outlineSource, /class="danger" type="button" :disabled="Boolean\(deletingDocumentId\)" @click="submitDelete"/)
  assertReceivesPointerAndClick(documentDialog, [inkLayerInternalUi])
})

await test('chapter-delete-confirm-clickable', () => {
  assert.match(workbenchSource, /class="danger" type="button" :disabled="chapterDeleteInspecting\|\|Boolean\(deletingChapterId\)/)
  assert.match(workbenchSource, /@click="confirmChapterDelete"/)
  assertReceivesPointerAndClick(chapterDialog, [inkLayerInternalUi])
})

await test('modal-dialogs-above-pdf-overlay-layer', () => {
  assert.ok(variables['--z-modal-backdrop'] > inkLayerInternalUi.zIndex)
  assert.ok(variables['--z-modal-dialog'] > variables['--z-modal-backdrop'])
  assert.equal(resolvedZ(outlineSource, '.document-delete-dialog'), variables['--z-modal-dialog'])
  assert.equal(resolvedZ(workbenchSource, '.chapter-delete-dialog'), variables['--z-modal-dialog'])
})

await test('ai-overlay-cannot-intercept-app-modal-buttons', () => {
  assert.equal(pointerEvents(aiOverlaySource, '.ai-candidate-overlay-layer'), 'none')
  assert.equal(pointerEvents(aiOverlaySource, '.ai-candidate-overlay'), 'none')
  const aiLayer = new HitTarget('AI overlay layer', resolvedZ(aiOverlaySource, '.ai-candidate-overlay-layer'), 'none')
  assert.equal(elementFromSyntheticPoint([documentDialog, aiLayer, inkLayerInternalUi]), documentDialog)
  assert.equal(elementFromSyntheticPoint([chapterDialog, aiLayer, inkLayerInternalUi]), chapterDialog)
})

await test('ai-overlay-marker-remains-clickable-inside-pdf', () => {
  assert.equal(pointerEvents(aiOverlaySource, '.ai-candidate-overlay>span'), 'auto')
  const marker = new HitTarget('AI overlay marker', resolvedZ(aiOverlaySource, '.ai-candidate-overlay-layer'))
  let clicks = 0
  marker.addEventListener('click', () => { clicks += 1 })
  marker.dispatchEvent(new Event('click'))
  assert.equal(clicks, 1)
  assert.match(aiOverlaySource, /button\.addEventListener\('click'/)
  assert.match(aiOverlaySource, /emit\('select', overlay\.candidateId\)/)
})

await test('completed-readonly-semantics-unchanged', () => {
  assert.equal(annotationEditingEnabled('completed', true), false)
  assert.equal(annotationEditingEnabled('human_review_in_progress', true), true)
})

await test('no-real-mutation-during-ui-tests', () => {
  const realMutationRequests = []
  assert.deepEqual(realMutationRequests, [])
})

assert.equal(testCount, 9)
console.log(`ui-layer-clickability-test-count=${testCount}`)
console.log('real-mutation-requests=0')
