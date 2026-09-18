// Synthetic shape-only fixture derived from the public adapter contract. It contains no provider data.
const FAKE_RECORD = Object.freeze({
  _score: 1,
  dy: 'FAKE_REGION',
  fbbm: 'FAKE_AUTHORITY',
  fbrq: 'FAKE_PUBLICATION_DATE',
  fgmc: 'FAKE_LAW',
  fwzh: 'FAKE_REFERENCE',
  id: 'FAKE_ID',
  ssrq: 'FAKE_EFFECTIVE_DATE',
  sxx: 'FAKE_STATUS',
  title: 'FAKE_TITLE',
  url: 'https://example.invalid/FAKE_URL',
  xljb_1: 'FAKE_AUTHORITY_LEVEL_1',
  xljb_2: 'FAKE_AUTHORITY_LEVEL_2',
})

export function observedFgSearchResponse({
  records = [{ ...FAKE_RECORD }],
  normalizedItems = records,
} = {}) {
  return {
    content: [],
    isError: false,
    structuredContent: {
      data: {
        data: records,
        message: 'FAKE_MESSAGE',
        status: 'FAKE_STATUS',
      },
      normalized: {
        hasItems: normalizedItems.length > 0,
        itemCount: normalizedItems.length,
        items: normalizedItems,
        resultPath: 'FAKE_RESULT_PATH',
      },
      ok: true,
      requestId: 'FAKE_REQUEST_ID',
      routeKey: 'FAKE_ROUTE_KEY',
      status: 200,
      tool: 'FAKE_TOOL',
    },
  }
}
