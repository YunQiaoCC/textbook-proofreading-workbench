import { RetrievalProviderError } from '../errors.mjs'

export const YUANDIAN_LAW_TOOLS = Object.freeze({
  VECTOR_SEARCH: 'yuandian_law_vector_search',
  ARTICLE_SEARCH: 'yuandian_rh_ft_search',
  STATUTE_SEARCH: 'yuandian_rh_fg_search',
  ARTICLE_DETAIL: 'yuandian_rh_ft_detail',
  STATUTE_DETAIL: 'yuandian_rh_fg_detail',
})

export const YUANDIAN_TOOL_ALLOWLIST = Object.freeze(Object.values(YUANDIAN_LAW_TOOLS))

// Documented contract expectations from the capability audit. These are not
// runtime-discovered MCP schemas. The first real-key smoke test must list tools
// and fail safely if the server's schemas conflict with these minimum fields.
export const YUANDIAN_TOOL_CONTRACTS = Object.freeze({
  [YUANDIAN_LAW_TOOLS.VECTOR_SEARCH]: {
    request: ['query', 'refer_date?'],
    response: ['candidate list', 'fgid?', 'ftid?', 'fgmc?', 'ftnum?', 'dy?'],
  },
  [YUANDIAN_LAW_TOOLS.ARTICLE_SEARCH]: {
    request: ['keyword', 'fgmc?', 'ftnum?', 'refer_date?'],
    response: ['candidate list', 'fgid?', 'ftid?', 'fgmc?', 'ftnum?', 'dy?'],
  },
  [YUANDIAN_LAW_TOOLS.STATUTE_SEARCH]: {
    request: ['fgmc', 'refer_date?'],
    response: ['candidate list', 'fgid?', 'fgmc?', 'dy?'],
  },
  [YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL]: {
    request: ['fgmc?', 'ftnum?', 'fgid?', 'ftid?', 'refer_date?'],
    response: ['fgmc', 'ftnum?', 'xljb', 'fbrq?', 'ssrq?', 'sxx?', 'detail text'],
  },
  [YUANDIAN_LAW_TOOLS.STATUTE_DETAIL]: {
    request: ['fgmc?', 'fgid?', 'refer_date?'],
    response: ['fgmc', 'xljb', 'fbrq?', 'ssrq?', 'sxx?', 'detail text'],
  },
})

export function assertAllowedYuandianTool(toolName) {
  if (!YUANDIAN_TOOL_ALLOWLIST.includes(toolName)) {
    throw new RetrievalProviderError('invalid_request', { providerCode: 'tool_not_allowed' })
  }
}
