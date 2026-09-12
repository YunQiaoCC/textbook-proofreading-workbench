import { RetrievalProviderError, normalizeProviderError } from '../errors.mjs'
import {
  createRetrievalResult,
  isHistoricalClaim,
  validateRetrievalClaim,
} from '../types.mjs'
import { YUANDIAN_LAW_TOOLS } from './tool-contracts.mjs'
import {
  detailRecord,
  normalizeYuandianDetail,
  readYuandianPayload,
  searchCandidates,
} from './normalize.mjs'

export const MAX_PROVIDER_CALLS_PER_CLAIM = 3
export const KEYWORD_SEARCH_DEFAULT_TOP_K = 5
export const VECTOR_SEARCH_DEFAULT_RETURN_NUM = 5

class ProviderCallBudgetError extends Error {}

function withDetailReferDate(claim, detailTool, args) {
  if (![YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL, YUANDIAN_LAW_TOOLS.STATUTE_DETAIL].includes(detailTool)) {
    throw new RetrievalProviderError('invalid_request')
  }
  return isHistoricalClaim(claim) ? { ...args, refer_date: claim.referenceDate } : args
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function articleDetailSelector(candidate, claim) {
  const id = nonEmpty(candidate?.id) ?? nonEmpty(candidate?.ftid)
  if (id) return { id }
  const fgmc = nonEmpty(candidate?.fgmc) ?? nonEmpty(claim.knownSourceTitle)
  const ftnum = nonEmpty(candidate?.ftnum) ?? nonEmpty(candidate?.ft_num) ?? nonEmpty(claim.knownArticleNumber)
  if (!fgmc || !ftnum) throw new RetrievalProviderError('invalid_request')
  return { fgmc, ftnum }
}

export function statuteDetailSelector(candidate, claim) {
  const id = nonEmpty(candidate?.id) ?? nonEmpty(candidate?.fgid)
  if (id) return { id }
  const fgmc = nonEmpty(candidate?.fgmc) ?? nonEmpty(claim.knownSourceTitle)
  if (!fgmc) throw new RetrievalProviderError('invalid_request')
  return { fgmc }
}

function selectorFor(detailTool, candidate, claim) {
  return detailTool === YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL
    ? articleDetailSelector(candidate, claim)
    : statuteDetailSelector(candidate, claim)
}

function resultForError(claimId, error) {
  const normalized = normalizeProviderError(error)
  const status = normalized.code === 'missing_api_key'
    ? 'provider_unavailable'
    : normalized.code === 'not_found'
      ? 'not_found'
      : 'provider_error'
  return createRetrievalResult(claimId, { status, error: normalized.toJSON() })
}

export class YuandianRetrievalAdapter {
  constructor({ client, maxProviderCalls = MAX_PROVIDER_CALLS_PER_CLAIM, now = () => new Date() }) {
    if (!client) throw new TypeError('client is required')
    if (!Number.isSafeInteger(maxProviderCalls) || maxProviderCalls < 1 || maxProviderCalls > 4) {
      throw new TypeError('maxProviderCalls must be between 1 and 4')
    }
    this.client = client
    this.maxProviderCalls = maxProviderCalls
    this.now = now
  }

  async #call(context, toolName, args) {
    if (context.calls >= this.maxProviderCalls) throw new ProviderCallBudgetError()
    context.calls += 1
    return this.client.callTool(toolName, args)
  }

  async #searchThenDetail(context, claim, searchTool, searchArgs, detailTool) {
    const searchResult = await this.#call(context, searchTool, searchArgs)
    const candidate = searchCandidates(readYuandianPayload(searchResult))[0]
    if (!candidate) return { notFound: true }
    const detailResult = await this.#call(
      context,
      detailTool,
      withDetailReferDate(claim, detailTool, selectorFor(detailTool, candidate, claim)),
    )
    return { detailResult, candidate, detailTool }
  }

  async #route(context, claim) {
    const knownArticle = claim.knownSourceTitle && claim.knownArticleNumber
    if (knownArticle && ['article_text', 'article_number'].includes(claim.kind)) {
      const detailTool = YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL
      const detailResult = await this.#call(context, detailTool, withDetailReferDate(claim, detailTool, {
        fgmc: claim.knownSourceTitle,
        ftnum: claim.knownArticleNumber,
      }))
      return { detailResult, candidate: null, detailTool }
    }

    if (claim.knownSourceTitle && [
      'statute_identity', 'legal_status', 'effective_date', 'historical_version', 'jurisdiction',
    ].includes(claim.kind)) {
      return this.#searchThenDetail(
        context,
        claim,
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        { fgmc: claim.knownSourceTitle, top_k: KEYWORD_SEARCH_DEFAULT_TOP_K },
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
    }

    if (['article_text', 'article_number'].includes(claim.kind)) {
      return this.#searchThenDetail(
        context,
        claim,
        YUANDIAN_LAW_TOOLS.ARTICLE_SEARCH,
        {
          keyword: [claim.text, claim.knownArticleNumber].filter(Boolean).join(' '),
          ...(claim.knownSourceTitle ? { fgmc: claim.knownSourceTitle } : {}),
          top_k: KEYWORD_SEARCH_DEFAULT_TOP_K,
        },
        YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL,
      )
    }

    if (claim.kind === 'statute_identity') {
      return this.#searchThenDetail(
        context,
        claim,
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        { fgmc: claim.text, top_k: KEYWORD_SEARCH_DEFAULT_TOP_K },
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
    }

    return this.#searchThenDetail(
      context,
      claim,
      YUANDIAN_LAW_TOOLS.VECTOR_SEARCH,
      { query: claim.text, return_num: VECTOR_SEARCH_DEFAULT_RETURN_NUM },
      YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL,
    )
  }

  async retrieve(input) {
    let claim
    try {
      claim = validateRetrievalClaim(input)
    } catch (error) {
      return createRetrievalResult(input?.claimId ?? 'invalid-claim', {
        status: 'provider_error',
        error: new RetrievalProviderError('invalid_request', { cause: error }).toJSON(),
      })
    }

    const status = this.client.getStatus?.()
    if (status && !status.configured) {
      return resultForError(claim.claimId, new RetrievalProviderError('missing_api_key'))
    }

    const context = { calls: 0 }
    try {
      const routed = await this.#route(context, claim)
      if (routed.notFound) return createRetrievalResult(claim.claimId, { status: 'not_found' })
      const record = detailRecord(readYuandianPayload(routed.detailResult))
      if (!record) return createRetrievalResult(claim.claimId, { status: 'not_found' })

      const normalized = normalizeYuandianDetail({
        claim,
        record,
        searchCandidate: routed.candidate,
        providerTool: routed.detailTool,
        retrievedAt: this.now().toISOString(),
      })
      if (!normalized.sufficient) {
        return createRetrievalResult(claim.claimId, {
          status: 'insufficient_evidence',
          provenance: normalized.provenance,
          warnings: normalized.warnings,
        })
      }
      return createRetrievalResult(claim.claimId, {
        status: 'evidence_found',
        evidence: [normalized.evidence],
        provenance: normalized.provenance,
        warnings: normalized.warnings,
      })
    } catch (error) {
      if (error instanceof ProviderCallBudgetError) {
        return createRetrievalResult(claim.claimId, {
          status: 'insufficient_evidence',
          warnings: ['provider_call_budget_exhausted'],
        })
      }
      return resultForError(claim.claimId, error)
    }
  }

  async close() {
    await this.client.close?.()
  }
}
