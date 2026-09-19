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

const captured = []
const telemetrySink = {
  async record(record) {
    captured.push(structuredClone(record))
    await persistentTelemetry.record(record)
  },
}

const client = new YuandianMcpClient()
const adapter = new YuandianRetrievalAdapter({ client, telemetrySink })
const claims = [
  ['A', '中华人民共和国劳动法', '第十五条'],
  ['B', '中华人民共和国劳动法', '第五十八条'],
  ['C', '未成年工特殊保护规定', '第二条'],
]

try {
  for (const [name, knownSourceTitle, knownArticleNumber] of claims) {
    const result = await adapter.retrieve({
      claimId: `production-canary-${name.toLowerCase()}-${Date.now()}`,
      kind: 'article_text',
      text: `${knownSourceTitle}${knownArticleNumber}`,
      knownSourceTitle,
      knownArticleNumber,
      temporalContext: 'current',
    })
    const telemetry = captured.at(-1)
    const detail = telemetry.detail
    console.log(JSON.stringify({
      canary: name,
      route: telemetry.routing.route,
      detailTool: telemetry.routing.detailTool,
      providerCallCount: telemetry.providerCallCount,
      providerStatus: telemetry.providerCalls.at(-1)?.status,
      detailRecordFound: detail.detailRecordFound,
      returnedTitle: detail.returnedTitle,
      returnedArticleNumber: detail.returnedArticleNumber,
      rawAuthorityLevelPresent: detail.rawAuthorityLevelPresent,
      jurisdictionPresent: detail.jurisdictionPresent,
      titleMatch: !result.warnings.includes('target_not_confirmed'),
      articleNumberMatch: !result.warnings.includes('article_number_not_confirmed'),
      normalizationSufficient: telemetry.normalization.sufficient,
      normalizationWarnings: telemetry.normalization.warnings,
      finalStatus: result.status,
    }))
  }
} finally {
  await adapter.close()
}
