import { RetrievalProviderError } from '../errors.mjs'

export const YUANDIAN_LAW_TOOLS = Object.freeze({
  VECTOR_SEARCH: 'yuandian_law_vector_search',
  ARTICLE_SEARCH: 'yuandian_rh_ft_search',
  STATUTE_SEARCH: 'yuandian_rh_fg_search',
  ARTICLE_DETAIL: 'yuandian_rh_ft_detail',
  STATUTE_DETAIL: 'yuandian_rh_fg_detail',
})

export const YUANDIAN_TOOL_ALLOWLIST = Object.freeze(Object.values(YUANDIAN_LAW_TOOLS))

const SEARCH_DATE_FIELDS = [
  'fbrq_start', 'fbrq_end', 'ssrq_start', 'ssrq_end',
]

// Input contract observed from the first real tools/list on 2026-09-12.
// `allowed` is a provider-private baseline, while `used` is the smaller set
// the v0.1 adapter may actually send. Runtime-observed response paths are
// recorded separately from legacy-compatible synthetic response paths.
export const YUANDIAN_TOOL_CONTRACTS = Object.freeze({
  [YUANDIAN_LAW_TOOLS.VECTOR_SEARCH]: {
    required: ['query'],
    allowed: ['query', 'rewrite_flag', 'fatiao_filter', 'return_num'],
    used: ['query', 'return_num'],
    parameterTypes: {
      query: 'string', rewrite_flag: 'boolean', fatiao_filter: 'object', return_num: 'number',
    },
    nestedFields: {
      fatiao_filter: {
        sxx: 'array:string', effect1: 'array:string', law_start: 'string', law_end: 'string',
      },
    },
    responseCollectionPath: ['data', 'extra', 'fatiao'],
    responseShape: 'array',
    responseFields: [
      'content', 'dy', 'effect1', 'effect2', 'end', 'fgid', 'fgtitle', 'ftid',
      'location', 'num', 'score', 'start', 'sxx', 'tag', 'type', 'url',
    ],
  },
  [YUANDIAN_LAW_TOOLS.ARTICLE_SEARCH]: {
    required: ['keyword'],
    allowed: [
      'keyword', 'search_mode', 'fgmc', 'xljb_1', 'sxx', 'dy', 'fbbm',
      ...SEARCH_DATE_FIELDS, 'top_k',
    ],
    used: ['keyword', 'fgmc', 'top_k'],
    parameterTypes: Object.fromEntries([
      'keyword', 'search_mode', 'fgmc', 'xljb_1', 'sxx', 'dy', 'fbbm',
      ...SEARCH_DATE_FIELDS,
    ].map((name) => [name, 'string']).concat([['top_k', 'number']])),
    responseFields: ['candidate list', 'id?', 'ftid?', 'fgid?', 'fgmc?', 'ftnum?', 'dy?'],
  },
  [YUANDIAN_LAW_TOOLS.STATUTE_SEARCH]: {
    required: [],
    allowed: [
      'keyword', 'search_mode', 'fgmc', 'sxx', 'dy', 'xljb_1', 'fbbm',
      ...SEARCH_DATE_FIELDS, 'top_k',
    ],
    used: ['fgmc', 'top_k'],
    parameterTypes: Object.fromEntries([
      'keyword', 'search_mode', 'fgmc', 'sxx', 'dy', 'xljb_1', 'fbbm',
      ...SEARCH_DATE_FIELDS,
    ].map((name) => [name, 'string']).concat([['top_k', 'number']])),
    responseCollectionPath: ['data', 'data'],
    responseShape: 'array',
    notFoundResponseShape: {
      dataPath: ['data'],
      dataKeys: ['message', 'status'],
      normalizedItemsPath: ['normalized', 'items'],
      normalizedResultPath: ['normalized', 'resultPath'],
    },
    responseFields: [
      '_score', 'dy', 'fbbm', 'fbrq', 'fgmc', 'fwzh', 'id',
      'ssrq', 'sxx', 'title', 'url', 'xljb_1', 'xljb_2',
    ],
  },
  [YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL]: {
    required: [],
    allowed: ['id', 'fgmc', 'ftnum', 'refer_date'],
    used: ['id', 'fgmc', 'ftnum', 'refer_date'],
    parameterTypes: { id: 'string', fgmc: 'string', ftnum: 'string', refer_date: 'string' },
    responseRecordPath: ['data', 'data'],
    responseShape: 'object',
    referDateInputVerifiedAccepted: true,
    explicitHistoricalVersionMarkerObserved: false,
    responseFields: [
      '_score', 'content', 'fbrq', 'fgid', 'fgmc', 'ft_num', 'ftmc', 'id',
      'ssrq', 'sxx', 'tid', 'title', 'type', 'url', 'xljb_1', 'xljb_2',
    ],
  },
  [YUANDIAN_LAW_TOOLS.STATUTE_DETAIL]: {
    required: [],
    allowed: ['id', 'fgmc', 'refer_date'],
    used: ['id', 'fgmc', 'refer_date'],
    parameterTypes: { id: 'string', fgmc: 'string', refer_date: 'string' },
    responseRecordPath: ['data', 'data'],
    responseShape: 'object',
    responseFields: [
      'content', 'fbbm', 'fbrq', 'fgid', 'fgmc', 'fwzh', 'id',
      'ssrq', 'sxx', 'type', 'url', 'xljb_1', 'xljb_2',
    ],
  },
})

const SEARCH_TOOLS = new Set([
  YUANDIAN_LAW_TOOLS.VECTOR_SEARCH,
  YUANDIAN_LAW_TOOLS.ARTICLE_SEARCH,
  YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
])

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function runtimeType(property) {
  if (!property || typeof property !== 'object') return undefined
  if (property.type === 'array') return `array:${property.items?.type ?? 'unknown'}`
  return property.type
}

export function validateYuandianRuntimeSchema(runtimeTools) {
  const tools = Array.isArray(runtimeTools)
    ? runtimeTools
    : Array.isArray(runtimeTools?.tools)
      ? runtimeTools.tools
      : []
  const byName = new Map(tools.map((tool) => [tool?.name, tool]))
  const missingTools = YUANDIAN_TOOL_ALLOWLIST.filter((name) => !byName.has(name))
  const incompatibleTools = new Set(missingTools)
  const drift = missingTools.map((name) => `${name}: missing tool`)

  for (const [toolName, contract] of Object.entries(YUANDIAN_TOOL_CONTRACTS)) {
    const schema = byName.get(toolName)?.inputSchema
    if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
      if (byName.has(toolName)) {
        incompatibleTools.add(toolName)
        drift.push(`${toolName}: inputSchema must be an object with properties`)
      }
      continue
    }

    const remoteRequired = Array.isArray(schema.required) ? schema.required : []
    if (!sameSet(contract.required, remoteRequired)) {
      incompatibleTools.add(toolName)
      drift.push(`${toolName}: required fields changed`)
    }

    for (const parameter of contract.allowed) {
      if (!Object.hasOwn(schema.properties, parameter)) {
        drift.push(`${toolName}: optional field ${parameter} is absent`)
        if (contract.used.includes(parameter)) incompatibleTools.add(toolName)
        continue
      }
      const actualType = runtimeType(schema.properties[parameter])
      const expectedType = contract.parameterTypes[parameter]
      if (actualType !== expectedType) {
        incompatibleTools.add(toolName)
        drift.push(`${toolName}.${parameter}: expected ${expectedType}, received ${actualType ?? 'unknown'}`)
      }
    }

    if (SEARCH_TOOLS.has(toolName) && Object.hasOwn(schema.properties, 'refer_date')) {
      incompatibleTools.add(toolName)
      drift.push(`${toolName}: refer_date must remain detail-only`)
    }

    for (const [parent, nested] of Object.entries(contract.nestedFields ?? {})) {
      const nestedProperties = schema.properties[parent]?.properties
      if (!nestedProperties || typeof nestedProperties !== 'object') {
        incompatibleTools.add(toolName)
        drift.push(`${toolName}.${parent}: nested properties are missing`)
        continue
      }
      for (const [field, expectedType] of Object.entries(nested)) {
        const actualType = runtimeType(nestedProperties[field])
        if (actualType !== expectedType) {
          incompatibleTools.add(toolName)
          drift.push(`${toolName}.${parent}.${field}: expected ${expectedType}, received ${actualType ?? 'unknown'}`)
        }
      }
    }
  }

  return {
    compatible: incompatibleTools.size === 0,
    missingTools,
    incompatibleTools: [...incompatibleTools],
    drift,
    extraTools: tools
      .map((tool) => tool?.name)
      .filter((name) => typeof name === 'string' && !YUANDIAN_TOOL_ALLOWLIST.includes(name)),
  }
}

export function assertAllowedYuandianTool(toolName) {
  if (!YUANDIAN_TOOL_ALLOWLIST.includes(toolName)) {
    throw new RetrievalProviderError('invalid_request', { providerCode: 'tool_not_allowed' })
  }
}
