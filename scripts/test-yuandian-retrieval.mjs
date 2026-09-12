#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import {
  YuandianMcpClient,
  YuandianRetrievalAdapter,
  createYuandianConfig,
  getYuandianStatus,
} from '../server/retrieval/index.mjs'
import { mapYuandianSourceType } from '../server/retrieval/yuandian/normalize.mjs'

const SECRET = 'test-secret-must-not-leak'
const NOW = new Date('2026-09-12T00:00:00.000Z')
const originalFetch = globalThis.fetch
let networkRequestSent = false
globalThis.fetch = async () => {
  networkRequestSent = true
  throw new Error('network access is forbidden in Yuandian mock tests')
}

function mcp(payload) {
  return { content: [], structuredContent: payload }
}

function statuteSearch(fgmc = '合成法律', extra = {}) {
  return mcp({ data: [{ fgid: 'fg-synth-1', fgmc, dy: '全国', ...extra }] })
}

function statuteDetail(overrides = {}) {
  return mcp({
    data: {
      fgid: 'fg-synth-1',
      fgmc: '合成法律',
      xljb: '法律',
      fbrq: '2000-01-02',
      ssrq: '2000-07-01',
      sxx: '有效',
      dy: '全国',
      fbbm: '合成立法机关',
      content: 'SYNTHETIC FULL RAW LAW BODY THAT MUST NOT BE PERSISTED',
      ...overrides,
    },
  })
}

function articleDetail(overrides = {}) {
  return mcp({
    data: {
      ftid: 'ft-synth-10',
      fgid: 'fg-synth-1',
      fgmc: '中华人民共和国劳动合同法',
      ftnum: '第十条',
      xljb: '法律',
      fbrq: '2007-06-29',
      ssrq: '2008-01-01',
      sxx: '有效',
      dy: '全国',
      ftnr: 'SYNTHETIC ARTICLE TEXT THAT MUST NOT BECOME SUPPORTS',
      ...overrides,
    },
  })
}

class MockSession {
  constructor(steps) {
    this.steps = [...steps]
    this.calls = []
    this.closed = false
  }

  async callTool(request, options) {
    this.calls.push({ request, options })
    const step = this.steps.shift()
    assert.ok(step, `unexpected tool call: ${request.name}`)
    assert.equal(request.name, step.tool)
    if (step.run) return step.run(request, options)
    if (step.error) throw step.error
    return step.result
  }

  async listTools() {
    return { tools: [] }
  }

  async close() {
    this.closed = true
  }
}

function harness(steps, options = {}) {
  const session = new MockSession(steps)
  let factoryCalls = 0
  const config = options.config ?? createYuandianConfig({
    env: {},
    apiKey: SECRET,
    timeoutMs: options.timeoutMs,
  })
  const client = new YuandianMcpClient({
    config,
    sessionFactory: async () => {
      factoryCalls += 1
      return session
    },
  })
  const adapter = new YuandianRetrievalAdapter({
    client,
    maxProviderCalls: options.maxProviderCalls,
    now: () => NOW,
  })
  return { session, client, adapter, factoryCalls: () => factoryCalls }
}

const tests = []
function test(name, run) {
  tests.push({ name, run })
}

test('statute search then detail normalizes law evidence', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_fg_search', result: statuteSearch() },
    { tool: 'yuandian_rh_fg_detail', result: statuteDetail() },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-statute',
    kind: 'effective_date',
    text: '合成施行日期命题',
    knownSourceTitle: '合成法律',
  })
  assert.equal(result.status, 'evidence_found')
  assert.equal(result.evidence[0].sourceType, 'law')
  assert.equal(result.evidence[0].publicationDate, '2000-01-02')
  assert.match(result.evidence[0].supports, /2000-07-01/u)
  assert.equal(result.provenance.effectiveDate, '2000-07-01')
  assert.deepEqual(session.calls.map((call) => call.request.name), [
    'yuandian_rh_fg_search', 'yuandian_rh_fg_detail',
  ])
})

test('known article routes directly to article detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_ft_detail', result: articleDetail() },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-known-article',
    kind: 'article_text',
    text: '合成法条命题',
    knownSourceTitle: '中华人民共和国劳动合同法',
    knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'evidence_found')
  assert.deepEqual(session.calls[0].request.arguments, {
    fgmc: '中华人民共和国劳动合同法', ftnum: '第十条',
  })
})

test('historical lookup sends refer_date to search and detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_fg_search', result: statuteSearch('某合成法规') },
    { tool: 'yuandian_rh_fg_detail', result: statuteDetail({ fgmc: '某合成法规', versionDate: '2000-12-31' }) },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-history',
    kind: 'historical_version',
    text: '历史合成命题',
    knownSourceTitle: '某合成法规',
    referenceDate: '2001-01-01',
  })
  assert.equal(result.status, 'evidence_found')
  assert.ok(session.calls.every((call) => call.request.arguments.refer_date === '2001-01-01'))
  assert.equal(result.provenance.requestedReferDate, '2001-01-01')
  assert.equal(result.provenance.resolvedVersionDate, '2000-12-31')
})

test('historical version date is never guessed', async () => {
  const { adapter } = harness([
    { tool: 'yuandian_rh_fg_search', result: statuteSearch() },
    { tool: 'yuandian_rh_fg_detail', result: statuteDetail() },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-history-unresolved', kind: 'historical_version', text: '合成历史命题',
    knownSourceTitle: '合成法律', referenceDate: '2001-01-01',
  })
  assert.equal(result.provenance.resolvedVersionDate, null)
  assert.ok(result.warnings.includes('version_resolution_not_explicit'))
})

test('search result cannot verify without detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_fg_search', result: statuteSearch() },
  ], { maxProviderCalls: 1 })
  const result = await adapter.retrieve({
    claimId: 'claim-search-only', kind: 'legal_status', text: '合成状态命题', knownSourceTitle: '合成法律',
  })
  assert.equal(result.status, 'insufficient_evidence')
  assert.deepEqual(result.evidence, [])
  assert.ok(result.warnings.includes('provider_call_budget_exhausted'))
  assert.equal(session.calls.length, 1)
})

test('missing key is unavailable without constructing a session', async () => {
  const config = createYuandianConfig({ env: {} })
  const { adapter, factoryCalls } = harness([], { config })
  const status = getYuandianStatus(config)
  const result = await adapter.retrieve({ claimId: 'claim-no-key', kind: 'statute_identity', text: '合成法规' })
  assert.equal(status.reason, 'missing_api_key')
  assert.equal(status.remoteChecked, false)
  assert.equal(result.status, 'provider_unavailable')
  assert.equal(result.error.code, 'missing_api_key')
  assert.equal(factoryCalls(), 0)
})

test('401 and 403 normalize to auth_error without retry', async () => {
  for (const status of [401, 403]) {
    const { adapter, session } = harness([
      { tool: 'yuandian_rh_ft_detail', error: { status, message: `raw ${status}` } },
    ])
    const result = await adapter.retrieve({
      claimId: `claim-auth-${status}`, kind: 'article_text', text: '合成法条',
      knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
    })
    assert.equal(result.error.code, 'auth_error')
    assert.equal(result.error.retryable, false)
    assert.equal(session.calls.length, 1)
  }
})

test('429 normalizes to retryable rate_limited without auto retry', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_ft_detail', error: { status: 429 } },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-rate', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.error.code, 'rate_limited')
  assert.equal(result.error.retryable, true)
  assert.equal(session.calls.length, 1)
})

test('MCP tool-level isError is normalized without exposing its body', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    result: { isError: true, content: [{ type: 'text', text: SECRET }], structuredContent: { status: 429 } },
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-tool-error', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.error.code, 'rate_limited')
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('timeout is bounded and normalized', async () => {
  const config = {
    provider: 'yuandian-law', configured: true, endpoint: 'https://example.invalid/mcp', timeoutMs: 20,
    getApiKey: () => SECRET,
  }
  const { adapter } = harness([
    { tool: 'yuandian_rh_ft_detail', run: () => new Promise(() => {}) },
  ], { config })
  const result = await adapter.retrieve({
    claimId: 'claim-timeout', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'provider_error')
  assert.equal(result.error.code, 'timeout')
})

test('provider 500 is a retryable provider_error', async () => {
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', error: { status: 500 } }])
  const result = await adapter.retrieve({
    claimId: 'claim-500', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.error.code, 'provider_error')
  assert.equal(result.error.retryable, true)
})

test('transport failures normalize without exposing low-level details', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    error: { code: 'ECONNREFUSED', message: `socket failed with ${SECRET}` },
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-transport', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.error.code, 'transport_error')
  assert.equal(result.error.retryable, true)
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('provider 404 maps to not_found', async () => {
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', error: { status: 404 } }])
  const result = await adapter.retrieve({
    claimId: 'claim-404', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'not_found')
  assert.equal(result.error.code, 'not_found')
})

test('unknown authority maps to other with raw level limitation', async () => {
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', result: articleDetail({ xljb: '合成未知类型' }) }])
  const result = await adapter.retrieve({
    claimId: 'claim-other', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.evidence[0].sourceType, 'other')
  assert.match(result.evidence[0].limitations, /rawAuthorityLevel: 合成未知类型/u)
})

test('local government rule maps to local_regulation with limitation', async () => {
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', result: articleDetail({ xljb: '地方政府规章' }) }])
  const result = await adapter.retrieve({
    claimId: 'claim-local-rule', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.evidence[0].sourceType, 'local_regulation')
  assert.match(result.evidence[0].limitations, /normalized from local government rule/u)
})

test('all documented source mappings remain deterministic', () => {
  const expected = {
    法律: 'law', 行政法规: 'administrative_regulation', 司法解释: 'judicial_interpretation',
    部门规章: 'department_rule', 地方性法规: 'local_regulation',
    自治条例和单行条例: 'local_regulation', 地方政府规章: 'local_regulation',
    普通规范性文件: 'normative_document',
  }
  for (const [raw, sourceType] of Object.entries(expected)) {
    assert.equal(mapYuandianSourceType(raw).sourceType, sourceType)
  }
})

test('missing detail jurisdiction warns and blocks jurisdiction-critical evidence', async () => {
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', result: articleDetail({ dy: undefined }) }])
  const result = await adapter.retrieve({
    claimId: 'claim-jurisdiction', kind: 'article_text', text: '合成地方法条', jurisdiction: '合成地区',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'insufficient_evidence')
  assert.ok(result.warnings.includes('jurisdiction_not_confirmed'))
  assert.deepEqual(result.evidence, [])
})

test('secret never appears in config status or normalized errors', async () => {
  const config = createYuandianConfig({ env: {}, apiKey: SECRET })
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', error: { status: 401, message: SECRET } }], { config })
  const result = await adapter.retrieve({
    claimId: 'claim-secret', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  const observable = JSON.stringify({ config, status: getYuandianStatus(config), result })
  assert.equal(observable.includes(SECRET), false)
  assert.equal(observable.includes('Authorization'), false)
})

test('thrown error metadata and stack do not retain the raw cause', async () => {
  const { client } = harness([{
    tool: 'yuandian_rh_ft_detail',
    error: { status: 401, code: SECRET, message: `Authorization: Bearer ${SECRET}` },
  }])
  await assert.rejects(
    client.callTool('yuandian_rh_ft_detail', { fgmc: '合成法律', ftnum: '第一条' }),
    (error) => {
      assert.equal(error.cause, undefined)
      assert.equal(JSON.stringify(error).includes(SECRET), false)
      assert.equal(String(error.stack).includes(SECRET), false)
      return error.code === 'auth_error'
    },
  )
})

test('raw provider response never enters normalized result', async () => {
  const marker = 'SYNTHETIC_RAW_PRIVATE_MARKER'
  const { adapter } = harness([{ tool: 'yuandian_rh_ft_detail', result: articleDetail({
    ftnr: marker, rawPrivateDebug: { marker }, requestHeaders: { Authorization: SECRET },
  }) }])
  const result = await adapter.retrieve({
    claimId: 'claim-raw', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(marker), false)
  assert.equal(serialized.includes(SECRET), false)
})

test('natural language proposition routes vector search then detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_law_vector_search', result: mcp({ data: [{ ftid: 'ft-synth-10', fgmc: '合成法律', ftnum: '第一条' }] }) },
    { tool: 'yuandian_rh_ft_detail', result: articleDetail({ fgmc: '合成法律', ftnum: '第一条' }) },
  ])
  const result = await adapter.retrieve({ claimId: 'claim-natural', kind: 'normative_proposition', text: '合成法律命题' })
  assert.equal(result.status, 'evidence_found')
  assert.deepEqual(session.calls.map((call) => call.request.name), [
    'yuandian_law_vector_search', 'yuandian_rh_ft_detail',
  ])
})

test('keyword article claim routes article search then detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_ft_search', result: mcp({ data: [{ ftid: 'ft-synth-10', fgmc: '中华人民共和国劳动合同法', ftnum: '第十条' }] }) },
    { tool: 'yuandian_rh_ft_detail', result: articleDetail() },
  ])
  const result = await adapter.retrieve({ claimId: 'claim-keyword', kind: 'article_text', text: '合成关键词' })
  assert.equal(result.status, 'evidence_found')
  assert.deepEqual(session.calls.map((call) => call.request.name), [
    'yuandian_rh_ft_search', 'yuandian_rh_ft_detail',
  ])
})

test('tool allowlist rejects yuandian-case before session creation', async () => {
  const { client, factoryCalls } = harness([])
  await assert.rejects(
    client.callTool('yuandian_case_search', {}),
    (error) => error.code === 'invalid_request' && error.retryable === false,
  )
  assert.equal(factoryCalls(), 0)
})

let passed = 0
try {
  for (const { name, run } of tests) {
    await run()
    passed += 1
    console.log(`${name}=pass`)
  }
  assert.equal(networkRequestSent, false)
  console.log(`mock-test-count=${passed}`)
  console.log('mcp-network-request-sent=no')
  console.log('yuandian-api-key-used=no')
} finally {
  globalThis.fetch = originalFetch
}
