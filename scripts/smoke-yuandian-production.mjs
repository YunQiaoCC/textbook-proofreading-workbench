import {
  YuandianMcpClient,
  YuandianRetrievalAdapter,
  getYuandianStatus,
} from '../server/retrieval/index.mjs'

const client = new YuandianMcpClient()
let providerCallCount = 0

const countedClient = {
  getStatus: () => client.getStatus(),
  async callTool(toolName, args) {
    providerCallCount += 1
    return client.callTool(toolName, args)
  },
  close: () => client.close(),
}

const adapter = new YuandianRetrievalAdapter({ client: countedClient })
const configured = getYuandianStatus(client.config).configured
let result

try {
  result = await adapter.retrieve({
    claimId: 'production-smoke',
    kind: 'article_text',
    text: '核验中华人民共和国劳动合同法第三条',
    knownSourceTitle: '中华人民共和国劳动合同法',
    knownArticleNumber: '第三条',
  })
} catch {
  result = {
    status: 'provider_error',
    evidence: [],
    provenance: null,
    warnings: ['smoke_exception'],
  }
} finally {
  await adapter.close()
}

const warnings = Array.isArray(result.warnings)
  ? result.warnings.filter((warning) => /^[a-z0-9_]+$/u.test(warning))
  : []
const evidenceCount = Array.isArray(result.evidence) ? result.evidence.length : 0
const evidenceFound = result.status === 'evidence_found' && evidenceCount > 0
const targetConfirmed = evidenceFound && !warnings.includes('target_not_confirmed')
const articleNumberConfirmed = evidenceFound && !warnings.includes('article_number_not_confirmed')
const providerRecordIdPresent =
  typeof result.provenance?.providerRecordId === 'string' &&
  result.provenance.providerRecordId.trim().length > 0

console.log(`YUANDIAN_CONFIGURED=${configured ? 'yes' : 'no'}`)
console.log(`YUANDIAN_SMOKE_STATUS=${result.status}`)
console.log(`EVIDENCE_COUNT=${evidenceCount}`)
console.log(`TARGET_CONFIRMED=${targetConfirmed ? 'yes' : 'no'}`)
console.log(`ARTICLE_NUMBER_CONFIRMED=${articleNumberConfirmed ? 'yes' : 'no'}`)
console.log(`PROVIDER_RECORD_ID_PRESENT=${providerRecordIdPresent ? 'yes' : 'no'}`)
console.log(`PROVIDER_CALL_COUNT=${providerCallCount}`)
console.log(`WARNINGS=[${warnings.join(',')}]`)

if (!configured || !evidenceFound) process.exitCode = 1
