<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ApiError } from '../services/apiClient'
import {
  completeUpload,
  createUploadSession,
  getUploadSession,
  MAX_DOCUMENT_SIZE,
  uploadPart,
  type UploadSession,
} from '../services/uploadApi'

type UploadPhase =
  | 'idle'
  | 'creating-session'
  | 'uploading'
  | 'paused'
  | 'finalizing'
  | 'inspecting'
  | 'completed'
  | 'failed'

interface PendingUpload {
  uploadId: string
  fileName: string
  fileSize: number
  lastModified: number
  chunkSize: number
}

const emit = defineEmits<{ completed: [documentId: string] }>()

const selectedFile = ref<File | null>(null)
const session = ref<UploadSession | null>(null)
const uploadId = ref<string | null>(null)
const receivedParts = ref<number[]>([])
const uploadedBytes = ref(0)
const phase = ref<UploadPhase>('idle')
const error = ref('')
const resumeNotice = ref('')
const duplicateNotice = ref('')
const requestedPause = ref(false)
const activeController = ref<AbortController | null>(null)
let operationId = 0

const phaseLabel: Record<UploadPhase, string> = {
  idle: '等待选择 PDF',
  'creating-session': '准备上传',
  uploading: '正在上传',
  paused: '已暂停',
  finalizing: '正在完成上传',
  inspecting: '正在检查 PDF',
  completed: '已完成',
  failed: '上传失败',
}

const progressPercent = computed(() => {
  const total = selectedFile.value?.size ?? 0
  return total > 0 ? Math.min(100, Math.floor((uploadedBytes.value / total) * 100)) : 0
})

const isRunning = computed(() => ['creating-session', 'uploading', 'finalizing'].includes(phase.value))
const canPause = computed(() => phase.value === 'uploading')
const canResume = computed(() => phase.value === 'paused')
const canRetry = computed(() => phase.value === 'failed' && Boolean(selectedFile.value))

function pendingKey(file: File) {
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`
  return `document-upload-pending:v1:${encodeURIComponent(fingerprint)}`
}

function readPending(file: File) {
  try {
    const raw = window.localStorage.getItem(pendingKey(file))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingUpload>
    if (
      typeof value.uploadId !== 'string' ||
      value.fileName !== file.name ||
      value.fileSize !== file.size ||
      value.lastModified !== file.lastModified ||
      !Number.isSafeInteger(value.chunkSize)
    ) return null
    return value as PendingUpload
  } catch {
    return null
  }
}

function savePending(file: File, currentSession: UploadSession) {
  const pending: PendingUpload = {
    uploadId: currentSession.id,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    chunkSize: currentSession.chunkSize,
  }
  window.localStorage.setItem(pendingKey(file), JSON.stringify(pending))
}

function clearPending(file: File) {
  window.localStorage.removeItem(pendingKey(file))
}

function partBytes(fileSize: number, chunkSize: number, partNumber: number) {
  const start = (partNumber - 1) * chunkSize
  return Math.max(0, Math.min(chunkSize, fileSize - start))
}

function applySession(nextSession: UploadSession, file: File) {
  session.value = nextSession
  uploadId.value = nextSession.id
  receivedParts.value = [...new Set(nextSession.receivedParts)].filter(
    (partNumber) => partNumber > 0 && partNumber <= nextSession.expectedParts,
  ).sort((left, right) => left - right)
  uploadedBytes.value = receivedParts.value.reduce(
    (total, partNumber) => total + partBytes(file.size, nextSession.chunkSize, partNumber),
    0,
  )
}

function isAbortError(value: unknown) {
  return value instanceof DOMException && value.name === 'AbortError'
}

function readableError(value: unknown) {
  if (value instanceof ApiError) {
    if (value.code === 'network_error') return '网络错误，请检查连接'
    if (value.code === 'invalid_pdf') return 'PDF 校验失败，请选择有效的 PDF 文件'
    if (value.code === 'missing_parts') return '分片不完整，请点击重试继续上传'
    if (value.code === 'upload_not_completable') return '上传会话已失效，请重新选择文件'
    if (value.code === 'part_too_large' || value.code === 'part_size_mismatch') return '分片大小不符合要求'
  }
  return '分片上传失败，请点击重试'
}

function validateFile(file: File) {
  const hasPdfType = file.type === 'application/pdf'
  const hasPdfExtension = file.name.toLowerCase().endsWith('.pdf')
  if (!hasPdfType && !hasPdfExtension) return '请选择 PDF 文件'
  if (file.size <= 0) return 'PDF 文件不能为空'
  if (file.size > MAX_DOCUMENT_SIZE) return 'PDF 文件超过 1 GiB 大小限制'
  return ''
}

function abortActiveRequest() {
  activeController.value?.abort()
  activeController.value = null
}

async function runUpload(currentOperationId: number) {
  const file = selectedFile.value
  const currentSession = session.value
  if (!file || !currentSession || currentOperationId !== operationId) return

  requestedPause.value = false
  phase.value = 'uploading'
  error.value = ''
  try {
    for (let partNumber = 1; partNumber <= currentSession.expectedParts; partNumber += 1) {
      if (currentOperationId !== operationId) return
      if (requestedPause.value) {
        phase.value = 'paused'
        return
      }
      if (receivedParts.value.includes(partNumber)) continue

      const start = (partNumber - 1) * currentSession.chunkSize
      const blob = file.slice(start, Math.min(file.size, start + currentSession.chunkSize))
      let uploaded = false
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        if (currentOperationId !== operationId) return
        if (requestedPause.value) {
          phase.value = 'paused'
          return
        }
        const controller = new AbortController()
        activeController.value = controller
        try {
          await uploadPart(currentSession.id, partNumber, blob, controller.signal)
          uploaded = true
          break
        } catch (uploadError) {
          if (currentOperationId !== operationId) return
          if (isAbortError(uploadError) && requestedPause.value) {
            phase.value = 'paused'
            return
          }
          if (attempt === 2) throw uploadError
        } finally {
          if (activeController.value === controller) activeController.value = null
        }
      }

      if (!uploaded) throw new Error('part upload did not complete')
      receivedParts.value = [...receivedParts.value, partNumber].sort((left, right) => left - right)
      uploadedBytes.value += blob.size
    }

    if (currentOperationId !== operationId) return
    phase.value = 'finalizing'
    const result = await completeUpload(currentSession.id)
    if (currentOperationId !== operationId) return
    clearPending(file)
    if (!result.document) {
      phase.value = 'failed'
      error.value = '上传已完成，但服务端没有返回文档信息'
      return
    }

    duplicateNotice.value = result.reusedExistingDocument
      ? '检测到该教材已存在，已进入现有教材继续协作，未创建重复副本。'
      : ''
    emit('completed', result.document.id)
    if (result.document.processingStatus === 'ready') {
      phase.value = 'completed'
    } else if (result.document.processingStatus === 'failed') {
      phase.value = 'failed'
      error.value = 'inspection failed，请检查 PDF 后重试'
    } else {
      phase.value = 'inspecting'
    }
  } catch (uploadError) {
    if (currentOperationId !== operationId) return
    if (isAbortError(uploadError) && requestedPause.value) {
      phase.value = 'paused'
      return
    }
    phase.value = 'failed'
    error.value = readableError(uploadError)
  } finally {
    if (activeController.value) activeController.value = null
  }
}

async function createAndUpload(file: File, currentOperationId: number) {
  phase.value = 'creating-session'
  try {
    const createdSession = await createUploadSession(file)
    if (currentOperationId !== operationId) return
    applySession(createdSession, file)
    savePending(file, createdSession)
    await runUpload(currentOperationId)
  } catch (uploadError) {
    if (currentOperationId !== operationId) return
    phase.value = 'failed'
    error.value = readableError(uploadError)
  }
}

async function refreshAndRun(currentOperationId: number) {
  const file = selectedFile.value
  const currentSession = session.value
  if (!file || !currentSession || currentOperationId !== operationId) return

  phase.value = 'creating-session'
  error.value = ''
  try {
    const refreshedSession = await getUploadSession(currentSession.id)
    if (currentOperationId !== operationId) return
    if (refreshedSession.status !== 'created' && refreshedSession.status !== 'uploading') {
      phase.value = 'failed'
      error.value = '上传会话已失效，请重新选择文件'
      return
    }
    applySession(refreshedSession, file)
    savePending(file, refreshedSession)
    await runUpload(currentOperationId)
  } catch (uploadError) {
    if (currentOperationId !== operationId) return
    phase.value = 'failed'
    error.value = readableError(uploadError)
  }
}

async function chooseFile(file: File) {
  operationId += 1
  const currentOperationId = operationId
  abortActiveRequest()
  requestedPause.value = false
  selectedFile.value = file
  session.value = null
  uploadId.value = null
  receivedParts.value = []
  uploadedBytes.value = 0
  phase.value = 'idle'
  error.value = ''
  resumeNotice.value = ''
  duplicateNotice.value = ''

  const validationError = validateFile(file)
  if (validationError) {
    error.value = validationError
    phase.value = 'failed'
    return
  }

  const pending = readPending(file)
  if (pending) {
    phase.value = 'creating-session'
    resumeNotice.value = '检测到未完成上传，请重新选择同一文件以继续。'
    try {
      const existingSession = await getUploadSession(pending.uploadId)
      if (currentOperationId !== operationId) return
      if (
        existingSession.status === 'created' ||
        existingSession.status === 'uploading'
      ) {
        if (existingSession.declaredByteSize === file.size && existingSession.chunkSize === pending.chunkSize) {
          applySession(existingSession, file)
          await runUpload(currentOperationId)
          return
        }
      }
      clearPending(file)
    } catch (resumeError) {
      if (currentOperationId !== operationId) return
      if (!(resumeError instanceof ApiError && resumeError.status === 404)) {
        phase.value = 'failed'
        error.value = '无法读取未完成上传状态，请稍后重试'
        return
      }
      clearPending(file)
    }
  }

  await createAndUpload(file, currentOperationId)
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void chooseFile(file)
}

function pause() {
  if (!canPause.value) return
  requestedPause.value = true
  phase.value = 'paused'
  abortActiveRequest()
}

function resume() {
  if (!canResume.value) return
  void refreshAndRun(operationId)
}

function retry() {
  const file = selectedFile.value
  if (!file || !canRetry.value) return
  if (session.value) void refreshAndRun(operationId)
  else void createAndUpload(file, operationId)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

onBeforeUnmount(() => {
  operationId += 1
  requestedPause.value = true
  abortActiveRequest()
})
</script>

<template>
  <section class="document-uploader" aria-label="上传教材">
    <label class="file-picker" :class="{ disabled: isRunning }">
      <span aria-hidden="true">＋</span>
      {{ selectedFile ? '更换 PDF' : '选择 PDF' }}
      <input type="file" accept="application/pdf,.pdf" :disabled="isRunning" @change="onFileChange" />
    </label>

    <p v-if="selectedFile" class="file-name" :title="selectedFile.name">{{ selectedFile.name }}</p>
    <p v-if="resumeNotice" class="resume-notice">{{ resumeNotice }}</p>
    <p v-if="duplicateNotice" class="duplicate-notice" role="status">{{ duplicateNotice }}</p>

    <div v-if="session" class="upload-progress">
      <div class="progress-heading"><span>{{ phaseLabel[phase] }}</span><strong>{{ progressPercent }}%</strong></div>
      <div class="progress-track"><span :style="{ width: `${progressPercent}%` }" /></div>
      <div class="progress-meta">
        <span>{{ receivedParts.length }} / {{ session.expectedParts }} 分片</span>
        <span>{{ formatBytes(uploadedBytes) }} / {{ formatBytes(selectedFile?.size ?? 0) }}</span>
      </div>
    </div>

    <div v-if="session || canRetry" class="uploader-actions">
      <button v-if="canPause" type="button" @click="pause">暂停</button>
      <button v-else-if="canResume" type="button" @click="resume">继续上传</button>
      <button v-else-if="canRetry" type="button" @click="retry">重试</button>
      <span v-else class="upload-status">{{ phaseLabel[phase] }}</span>
    </div>

    <p v-if="error" class="uploader-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.document-uploader { padding: 9px 12px; background: #f1f4f8; border-bottom: 1px solid #dce2ea; }
.file-picker { display: flex; align-items: center; justify-content: center; gap: 5px; padding: 7px 6px; color: #496991; font-size: 10px; background: #fff; border: 1px solid #cbd8e7; border-radius: 5px; cursor: pointer; }
.file-picker:hover { background: #f6f9fd; border-color: #a9bfd8; }
.file-picker.disabled { cursor: not-allowed; opacity: .6; }
.file-picker input { display: none; }
.file-name { margin: 8px 1px 0; overflow: hidden; color: #53627a; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.resume-notice { margin: 7px 1px 0; color: #8b6a35; font-size: 9px; line-height: 1.4; }
.duplicate-notice { margin: 7px 1px 0; color: #3f6f5b; font-size: 9px; line-height: 1.4; }
.upload-progress { margin-top: 9px; }
.progress-heading, .progress-meta { display: flex; align-items: center; justify-content: space-between; gap: 5px; }
.progress-heading { color: #60708a; font-size: 9px; } .progress-heading strong { color: #496991; font-size: 10px; }
.progress-track { height: 5px; margin-top: 5px; overflow: hidden; background: #dce4ee; border-radius: 5px; }
.progress-track span { display: block; height: 100%; background: #5f82ad; border-radius: 5px; transition: width .15s ease; }
.progress-meta { margin-top: 5px; color: #9ba5b4; font-size: 8px; }
.uploader-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.uploader-actions button { padding: 5px 8px; color: #4e6f9d; font-size: 9px; background: #fff; border: 1px solid #cbd8e7; border-radius: 4px; }
.upload-status { color: #728096; font-size: 9px; }
.uploader-error { margin: 8px 1px 0; color: #a55555; font-size: 9px; line-height: 1.4; }
</style>
