#!/usr/bin/env node

import path from 'node:path'
import {
  FileBackedRetrievalTelemetry,
  YuandianMcpClient,
  YuandianRetrievalAdapter,
} from '../server/retrieval/index.mjs'

const storageRoot = path.resolve(process.env.DOCUMENT_STORAGE_ROOT ?? 'storage')
const persistentTelemetry = new FileBackedRetrievalTelemetry(storageRoot)
await persistentTelemetry.init()
let captured
const telemetrySink = {
  async record(record) {
    captured = structuredClone(record)
    await persistentTelemetry.record(record)
  },
}
const client = new YuandianMcpClient()
const adapter = new YuandianRetrievalAdapter({ client, telemetrySink })

try {
  const result = await adapter.retrieve({
    claimId: `production-direct-detail-canary-${Date.now()}`,
    kind: 'article_text',
    text: '关于贯彻执行中华人民共和国劳动法若干问题的意见第53条',
    knownSourceTitle: '《关于贯彻执行〈中华人民共和国劳动法〉若干问题的意见》',
    knownArticleNumber: '第53条',
    temporalContext: 'current',
  })
  console.log(JSON.stringify({
    directDetailCallStatus: captured.providerCalls[0]?.status,
    detailRecordFound: captured.detail.detailRecordFound,
    safeResponseShape: captured.detail.responseShape,
    normalizedErrorCode: captured.error?.code ?? null,
    normalizedProviderCode: captured.error?.providerCode ?? null,
    normalizedRetryable: captured.error?.retryable ?? null,
    finalStatus: result.status,
  }))
} finally {
  await adapter.close()
}
