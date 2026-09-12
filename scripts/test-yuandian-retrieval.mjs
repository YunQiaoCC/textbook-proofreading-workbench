#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import {
  KEYWORD_SEARCH_DEFAULT_TOP_K,
  VECTOR_SEARCH_DEFAULT_RETURN_NUM,
  YUANDIAN_TOOL_CONTRACTS,
  YuandianMcpClient,
  YuandianRetrievalAdapter,
  createYuandianConfig,
  getYuandianStatus,
  validateYuandianRuntimeSchema,
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

function property(type, nestedProperties) {
  return {
    type,
    ...(nestedProperties ? { properties: nestedProperties, required: [], additionalProperties: true } : {}),
  }
}

function runtimeTool(name, properties, required = []) {
  return { name, inputSchema: { type: 'object', properties, required, additionalProperties: true } }
}

function observedRuntimeTools() {
  const searchStrings = Object.fromEntries([
    'keyword', 'search_mode', 'fgmc', 'xljb_1', 'sxx', 'dy', 'fbbm',
    'fbrq_start', 'fbrq_end', 'ssrq_start', 'ssrq_end',
  ].map((name) => [name, property('string')]))
  return [
    runtimeTool('yuandian_law_vector_search', {
      query: property('string'),
      rewrite_flag: property('boolean'),
      fatiao_filter: property('object', {
        sxx: { type: 'array', items: { type: 'string' } },
        effect1: { type: 'array', items: { type: 'string' } },
        law_start: property('string'),
        law_end: property('string'),
      }),
      return_num: property('number'),
    }, ['query']),
    runtimeTool('yuandian_rh_ft_search', { ...searchStrings, top_k: property('number') }, ['keyword']),
    runtimeTool('yuandian_rh_fg_search', { ...searchStrings, top_k: property('number') }),
    runtimeTool('yuandian_rh_ft_detail', {
      id: property('string'), fgmc: property('string'), ftnum: property('string'), refer_date: property('string'),
    }),
    runtimeTool('yuandian_rh_fg_detail', {
      id: property('string'), fgmc: property('string'), refer_date: property('string'),
    }),
  ]
}

function actualType(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function assertRuntimeObservedRequest(request) {
  const contract = YUANDIAN_TOOL_CONTRACTS[request.name]
  assert.ok(contract, `tool is outside runtime contract: ${request.name}`)
  const args = request.arguments ?? {}
  for (const field of Object.keys(args)) {
    assert.ok(contract.allowed.includes(field), `${request.name} must not send ${field}`)
    assert.equal(actualType(args[field]), contract.parameterTypes[field], `${request.name}.${field} type`)
  }
  for (const field of contract.required) assert.ok(Object.hasOwn(args, field), `${request.name} requires ${field}`)
  if (request.name.endsWith('_search') || request.name === 'yuandian_law_vector_search') {
    assert.equal(Object.hasOwn(args, 'refer_date'), false, `${request.name} must not send refer_date`)
  }
  if (request.name === 'yuandian_rh_ft_search') {
    assert.equal(Object.hasOwn(args, 'ftnum'), false, 'article search must not send ftnum')
  }
  if (request.name.endsWith('_detail')) {
    assert.equal(Object.hasOwn(args, 'fgid'), false, 'detail request must not send fgid')
    assert.equal(Object.hasOwn(args, 'ftid'), false, 'detail request must not send ftid')
  }
  if (request.name === 'yuandian_rh_ft_detail' && !args.id) {
    assert.ok(args.fgmc && args.ftnum, 'article detail without id requires fgmc + ftnum')
  }
  if (request.name === 'yuandian_rh_fg_detail' && !args.id) {
    assert.ok(args.fgmc, 'statute detail without id requires fgmc')
  }
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
    assertRuntimeObservedRequest(request)
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
  assert.deepEqual(session.calls[0].request.arguments, {
    fgmc: '合成法律', top_k: KEYWORD_SEARCH_DEFAULT_TOP_K,
  })
  assert.deepEqual(session.calls[1].request.arguments, { id: 'fg-synth-1' })
})

test('runtime candidate id is forwarded as canonical statute detail id', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_fg_search', result: mcp({ data: [{ id: 'runtime-fg-id', fgmc: '合成法律' }] }) },
    { tool: 'yuandian_rh_fg_detail', result: statuteDetail({ id: 'runtime-fg-id' }) },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-runtime-id', kind: 'legal_status', text: '合成状态', knownSourceTitle: '合成法律',
  })
  assert.equal(result.status, 'evidence_found')
  assert.deepEqual(session.calls[1].request.arguments, { id: 'runtime-fg-id' })
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

test('historical known article sends refer_date only to direct detail', async () => {
  const { adapter, session } = harness([
    { tool: 'yuandian_rh_ft_detail', result: articleDetail({ versionDate: '2009-12-31' }) },
  ])
  const result = await adapter.retrieve({
    claimId: 'claim-known-article-history',
    kind: 'article_text',
    text: '合成历史法条命题',
    temporalContext: 'historical',
    referenceDate: '2010-01-01',
    knownSourceTitle: '中华人民共和国劳动合同法',
    knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'evidence_found')
  assert.deepEqual(session.calls[0].request.arguments, {
    fgmc: '中华人民共和国劳动合同法', ftnum: '第十条', refer_date: '2010-01-01',
  })
})

test('historical statute sends refer_date only to detail', async () => {
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
  assert.equal(Object.hasOwn(session.calls[0].request.arguments, 'refer_date'), false)
  assert.deepEqual(session.calls[0].request.arguments, {
    fgmc: '某合成法规', top_k: KEYWORD_SEARCH_DEFAULT_TOP_K,
  })
  assert.deepEqual(session.calls[1].request.arguments, {
    id: 'fg-synth-1', refer_date: '2001-01-01',
  })
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

test('xljb_1 is the preferred authority-level response alias', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    result: articleDetail({ xljb_1: '行政法规', xljb: '法律' }),
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-xljb-1', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.evidence[0].sourceType, 'administrative_regulation')
  assert.equal(result.provenance.rawAuthorityLevel, '行政法规')
})

test('xljb_2 is a defensive fallback and preserves unknown values as other', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    result: articleDetail({ xljb_2: '合成二级效力类型', xljb: undefined }),
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-xljb-2', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.evidence[0].sourceType, 'other')
  assert.match(result.evidence[0].limitations, /rawAuthorityLevel: 合成二级效力类型/u)
})

test('ft_num response alias normalizes article number', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    result: articleDetail({ ftnum: undefined, ft_num: '第十条' }),
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-ft-num', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.status, 'evidence_found')
  assert.match(result.evidence[0].supports, /第十条/u)
})

test('providerRecordId prefers canonical id over response aliases', async () => {
  const { adapter } = harness([{
    tool: 'yuandian_rh_ft_detail',
    result: articleDetail({ id: 'canonical-id', ftid: 'legacy-ftid', fgid: 'legacy-fgid' }),
  }])
  const result = await adapter.retrieve({
    claimId: 'claim-id-priority', kind: 'article_text', text: '合成法条',
    knownSourceTitle: '中华人民共和国劳动合同法', knownArticleNumber: '第十条',
  })
  assert.equal(result.provenance.providerRecordId, 'canonical-id')
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
  assert.deepEqual(session.calls[0].request.arguments, {
    query: '合成法律命题', return_num: VECTOR_SEARCH_DEFAULT_RETURN_NUM,
  })
  assert.equal(Object.hasOwn(session.calls[0].request.arguments, 'refer_date'), false)
  assert.deepEqual(session.calls[1].request.arguments, { id: 'ft-synth-10' })
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
  assert.deepEqual(session.calls[0].request.arguments, {
    keyword: '合成关键词', top_k: KEYWORD_SEARCH_DEFAULT_TOP_K,
  })
  assert.equal(Object.hasOwn(session.calls[0].request.arguments, 'ftnum'), false)
  assert.deepEqual(session.calls[1].request.arguments, { id: 'ft-synth-10' })
})

test('observed five-tool runtime schema is compatible', () => {
  const result = validateYuandianRuntimeSchema({ tools: observedRuntimeTools() })
  assert.equal(result.compatible, true)
  assert.deepEqual(result.missingTools, [])
  assert.deepEqual(result.incompatibleTools, [])
  assert.deepEqual(result.drift, [])
})

test('missing allowlisted runtime tool is incompatible', () => {
  const tools = observedRuntimeTools().filter((tool) => tool.name !== 'yuandian_rh_fg_detail')
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, false)
  assert.deepEqual(result.missingTools, ['yuandian_rh_fg_detail'])
})

test('additional remote tool and optional parameter remain compatible', () => {
  const tools = observedRuntimeTools()
  tools[0].inputSchema.properties.future_optional = property('string')
  tools.push(runtimeTool('yuandian_get_user_balance', {}))
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, true)
  assert.deepEqual(result.extraTools, ['yuandian_get_user_balance'])
})

test('required-field runtime drift is incompatible', () => {
  const tools = observedRuntimeTools()
  tools.find((tool) => tool.name === 'yuandian_rh_fg_search').inputSchema.required = ['fgmc']
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, false)
  assert.ok(result.incompatibleTools.includes('yuandian_rh_fg_search'))
})

test('parameter-type runtime drift is incompatible', () => {
  const tools = observedRuntimeTools()
  tools.find((tool) => tool.name === 'yuandian_rh_ft_detail').inputSchema.properties.ftnum.type = 'number'
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, false)
  assert.ok(result.incompatibleTools.includes('yuandian_rh_ft_detail'))
})

test('refer_date placement drift on search is incompatible', () => {
  const tools = observedRuntimeTools()
  tools.find((tool) => tool.name === 'yuandian_rh_fg_search').inputSchema.properties.refer_date = property('string')
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, false)
  assert.ok(result.incompatibleTools.includes('yuandian_rh_fg_search'))
})

test('critical vector filter nested-type drift is incompatible', () => {
  const tools = observedRuntimeTools()
  const vector = tools.find((tool) => tool.name === 'yuandian_law_vector_search')
  vector.inputSchema.properties.fatiao_filter.properties.sxx.items.type = 'number'
  const result = validateYuandianRuntimeSchema(tools)
  assert.equal(result.compatible, false)
  assert.ok(result.incompatibleTools.includes('yuandian_law_vector_search'))
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
