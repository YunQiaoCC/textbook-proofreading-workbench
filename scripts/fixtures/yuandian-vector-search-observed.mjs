const FAKE_VECTOR_RECORD = Object.freeze({
  content: 'FAKE_VECTOR_CONTENT',
  dy: 'FAKE_REGION',
  effect1: 'FAKE_AUTHORITY_LEVEL_1',
  effect2: 'FAKE_AUTHORITY_LEVEL_2',
  end: 20,
  fgid: 'FAKE_FGID',
  fgtitle: 'FAKE_LAW',
  ftid: 'FAKE_FTID',
  location: 'FAKE_LOCATION',
  num: 'FAKE_ARTICLE',
  score: 1,
  start: 10,
  sxx: 'FAKE_STATUS',
  tag: 'FAKE_TAG',
  type: 'FAKE_TYPE',
  url: 'https://example.invalid/FAKE_VECTOR',
})

export function observedVectorSearchResponse(overrides = {}) {
  const record = { ...FAKE_VECTOR_RECORD, ...overrides }
  return {
    content: [],
    isError: false,
    structuredContent: {
      data: {
        answer: 'FAKE_ANSWER',
        extra: { fatiao: [record] },
        messageId: 'FAKE_MESSAGE_ID',
        msg: 'FAKE_MESSAGE',
        request_id: 'FAKE_REQUEST_ID',
        style: 'FAKE_STYLE',
      },
      normalized: { hasItems: true, itemCount: 1, items: [record], resultPath: 'FAKE_RESULT_PATH' },
      ok: true,
      requestId: 'FAKE_REQUEST_ID',
      routeKey: 'FAKE_ROUTE_KEY',
      status: 200,
      tool: 'FAKE_TOOL',
    },
  }
}
