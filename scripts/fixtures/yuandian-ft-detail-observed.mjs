const FAKE_FT_DETAIL = Object.freeze({
  _score: 1,
  content: 'FAKE_CONTENT',
  fbrq: 'FAKE_PUBLICATION_DATE',
  fgid: 'FAKE_FGID',
  fgmc: 'FAKE_LAW',
  ft_num: 'FAKE_ARTICLE',
  ftmc: 'FAKE_ARTICLE_TITLE',
  id: 'FAKE_ID',
  ssrq: 'FAKE_EFFECTIVE_DATE',
  sxx: 'FAKE_STATUS',
  tid: 'FAKE_TID',
  title: 'FAKE_TITLE',
  type: 'FAKE_TYPE',
  url: 'https://example.invalid/FAKE_FT_DETAIL',
  xljb_1: 'FAKE_AUTHORITY_LEVEL_1',
  xljb_2: 'FAKE_AUTHORITY_LEVEL_2',
})

export function observedFtDetailResponse(overrides = {}) {
  return {
    content: [],
    isError: false,
    structuredContent: {
      data: {
        data: { ...FAKE_FT_DETAIL, ...overrides },
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
