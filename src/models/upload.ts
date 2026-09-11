export const uploadSessionStatuses = [
  'created',
  'uploading',
  'assembling',
  'completed',
  'failed',
  'expired',
] as const

export type UploadSessionStatus = (typeof uploadSessionStatuses)[number]

export interface UploadSession {
  id: string
  originalFilename: string
  declaredByteSize: number
  chunkSize: number
  expectedParts: number
  receivedParts: readonly number[]
  status: UploadSessionStatus
  createdAt: string
  updatedAt: string
  expiresAt: string
  documentId?: string
  errorMessage?: string
}

export interface UploadPart {
  uploadSessionId: string
  partNumber: number
  byteSize: number
  receivedAt: string
}
