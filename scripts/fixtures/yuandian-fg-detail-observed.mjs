// Synthetic shape-only fixture derived from the public adapter contract. It contains no provider data.
const FAKE_FG_DETAIL = Object.freeze({
  content: 'FAKE_CONTENT',
  fbbm: 'FAKE_AUTHORITY',
  fbrq: 'FAKE_PUBLICATION_DATE',
  fgid: 'FAKE_FGID',
  fgmc: 'FAKE_LAW',
  fwzh: 'FAKE_REFERENCE',
  id: 'FAKE_ID',
  ssrq: 'FAKE_EFFECTIVE_DATE',
  sxx: 'FAKE_STATUS',
  type: 'FAKE_TYPE',
  url: 'https://example.invalid/FAKE_FG_DETAIL',
  xljb_1: 'FAKE_AUTHORITY_LEVEL_1',
  xljb_2: 'FAKE_AUTHORITY_LEVEL_2',
})

export function observedFgDetailResponse(overrides = {}) {
  return {
    content: [],
    isError: false,
    structuredContent: {
      data: {
        data: { ...FAKE_FG_DETAIL, ...overrides },
        message: 'FAKE_MESSAGE',
        status: 'FAKE_STATUS',
      },
      normalized: { hasItems: false, itemCount: 0, items: [], resultPath: null },
      ok: true,
      requestId: 'FAKE_REQUEST_ID',
      routeKey: 'FAKE_ROUTE_KEY',
      status: 200,
      tool: 'FAKE_TOOL',
    },
  }
}
