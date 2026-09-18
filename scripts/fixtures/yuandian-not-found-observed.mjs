// Synthetic shape-only fixture derived from the public adapter contract. It contains no provider data.
export function observedNotFoundResponse() {
  return {
    content: [],
    isError: false,
    structuredContent: {
      data: { message: 'FAKE_NOT_FOUND_MESSAGE', status: 'FAKE_STATUS' },
      normalized: { hasItems: false, itemCount: 0, items: [], resultPath: null },
      ok: true,
      requestId: 'FAKE_REQUEST_ID',
      routeKey: 'FAKE_ROUTE_KEY',
      status: 200,
      tool: 'FAKE_TOOL',
    },
  }
}
