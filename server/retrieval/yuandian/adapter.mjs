import { RetrievalProviderError, normalizeProviderError } from '../errors.mjs'
import {
  createRetrievalResult,
  isHistoricalClaim,
  validateRetrievalClaim,
} from '../types.mjs'
import { YUANDIAN_LAW_TOOLS } from './tool-contracts.mjs'
import {
  classifyYuandianSearchPayload,
  detailRecord,
  normalizeYuandianDetail,
  readYuandianPayload,
} from './normalize.mjs'
import {
  createSafeRetrievalTelemetry,
  finalizeSafeRetrievalTelemetry,
  recordTelemetryProviderCall,
  recordTelemetryRoute,
  safeDetailTelemetry,
  safeSearchCandidateTelemetry,
  updateLastTelemetryProviderCall,
} from '../telemetry.mjs'

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

function candidateForSelector(candidate, searchTool) {
  if (searchTool !== YUANDIAN_LAW_TOOLS.VECTOR_SEARCH) return candidate
  return {
    ...candidate,
    fgmc: nonEmpty(candidate?.fgmc) ?? nonEmpty(candidate?.fgtitle),
    ftnum: nonEmpty(candidate?.ftnum) ?? nonEmpty(candidate?.ft_num) ?? nonEmpty(candidate?.num),
  }
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
  constructor({ client, maxProviderCalls = MAX_PROVIDER_CALLS_PER_CLAIM, now = () => new Date(), telemetrySink }) {
    if (!client) throw new TypeError('client is required')
    if (!Number.isSafeInteger(maxProviderCalls) || maxProviderCalls < 1 || maxProviderCalls > 4) {
      throw new TypeError('maxProviderCalls must be between 1 and 4')
    }
    this.client = client
    this.maxProviderCalls = maxProviderCalls
    this.now = now
    this.telemetrySink = telemetrySink
  }

  async #call(context, toolName, args) {
    if (context.calls >= this.maxProviderCalls) throw new ProviderCallBudgetError()
    context.calls += 1
    recordTelemetryProviderCall(context.telemetry, {
      tool: toolName, status: 'ok', resultKind: 'response_received',
    })
    try {
      return await this.client.callTool(toolName, args)
    } catch (error) {
      const normalized = normalizeProviderError(error)
      updateLastTelemetryProviderCall(context.telemetry, {
        status: normalized.code, resultKind: 'error',
      })
      throw error
    }
  }

  async #searchThenDetail(context, claim, searchTool, searchArgs, detailTool) {
    const searchResult = await this.#call(context, searchTool, searchArgs)
    const classified = classifyYuandianSearchPayload(readYuandianPayload(searchResult))
    updateLastTelemetryProviderCall(context.telemetry, {
      resultKind: classified.kind,
      candidateCount: classified.candidates.length,
    })
    context.telemetry.searchCandidates = safeSearchCandidateTelemetry(classified.candidates)
    if (classified.kind === 'not_found') return { notFound: true }
    const candidate = classified.candidates[0]
    if (!candidate) return { notFound: true }
    context.telemetry.selectedCandidateRank = 1
    const selectorCandidate = candidateForSelector(candidate, searchTool)
    const detailResult = await this.#call(
      context,
      detailTool,
      withDetailReferDate(claim, detailTool, selectorFor(detailTool, selectorCandidate, claim)),
    )
    return { detailResult, candidate, detailTool }
  }

  async #route(context, claim) {
    const knownArticle = claim.knownSourceTitle && claim.knownArticleNumber
    if (knownArticle && ['article_text', 'article_number'].includes(claim.kind)) {
      const detailTool = YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL
      recordTelemetryRoute(context.telemetry, 'direct_article_detail', undefined, detailTool)
      const detailResult = await this.#call(context, detailTool, withDetailReferDate(claim, detailTool, {
        fgmc: claim.knownSourceTitle,
        ftnum: claim.knownArticleNumber,
      }))
      return { detailResult, candidate: null, detailTool }
    }

    if (claim.knownSourceTitle && [
      'statute_identity', 'legal_status', 'effective_date', 'historical_version', 'jurisdiction',
    ].includes(claim.kind)) {
      recordTelemetryRoute(
        context.telemetry,
        'statute_search_detail',
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
      return this.#searchThenDetail(
        context,
        claim,
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        { fgmc: claim.knownSourceTitle, top_k: KEYWORD_SEARCH_DEFAULT_TOP_K },
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
    }

    if (['article_text', 'article_number'].includes(claim.kind)) {
      recordTelemetryRoute(
        context.telemetry,
        'article_search_detail',
        YUANDIAN_LAW_TOOLS.ARTICLE_SEARCH,
        YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL,
      )
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
      recordTelemetryRoute(
        context.telemetry,
        'statute_search_detail',
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
      return this.#searchThenDetail(
        context,
        claim,
        YUANDIAN_LAW_TOOLS.STATUTE_SEARCH,
        { fgmc: claim.text, top_k: KEYWORD_SEARCH_DEFAULT_TOP_K },
        YUANDIAN_LAW_TOOLS.STATUTE_DETAIL,
      )
    }

    recordTelemetryRoute(
      context.telemetry,
      'vector_search_detail',
      YUANDIAN_LAW_TOOLS.VECTOR_SEARCH,
      YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL,
    )
    return this.#searchThenDetail(
      context,
      claim,
      YUANDIAN_LAW_TOOLS.VECTOR_SEARCH,
      { query: claim.text, return_num: VECTOR_SEARCH_DEFAULT_RETURN_NUM },
      YUANDIAN_LAW_TOOLS.ARTICLE_DETAIL,
    )
  }

  async #finish(telemetry, result, normalized) {
    finalizeSafeRetrievalTelemetry(telemetry, result, normalized)
    try {
      await this.telemetrySink?.record?.(telemetry)
    } catch {
      // Retrieval remains available if optional diagnostics cannot be persisted.
    }
    return result
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

    const telemetry = createSafeRetrievalTelemetry(claim, this.now().toISOString())
    const status = this.client.getStatus?.()
    if (status && !status.configured) {
      return this.#finish(
        telemetry,
        resultForError(claim.claimId, new RetrievalProviderError('missing_api_key')),
      )
    }

    const context = { calls: 0, telemetry }
    try {
      const routed = await this.#route(context, claim)
      if (routed.notFound) {
        return this.#finish(telemetry, createRetrievalResult(claim.claimId, { status: 'not_found' }))
      }
      const record = detailRecord(readYuandianPayload(routed.detailResult))
      telemetry.detail = safeDetailTelemetry(record)
      updateLastTelemetryProviderCall(telemetry, {
        resultKind: record ? 'detail_record' : 'not_found',
      })
      if (!record) {
        return this.#finish(telemetry, createRetrievalResult(claim.claimId, { status: 'not_found' }))
      }

      const normalized = normalizeYuandianDetail({
        claim,
        record,
        searchCandidate: routed.candidate,
        providerTool: routed.detailTool,
        retrievedAt: this.now().toISOString(),
      })
      if (!normalized.sufficient) {
        return this.#finish(telemetry, createRetrievalResult(claim.claimId, {
          status: 'insufficient_evidence',
          provenance: normalized.provenance,
          warnings: normalized.warnings,
        }), normalized)
      }
      return this.#finish(telemetry, createRetrievalResult(claim.claimId, {
        status: 'evidence_found',
        evidence: [normalized.evidence],
        provenance: normalized.provenance,
        warnings: normalized.warnings,
      }), normalized)
    } catch (error) {
      if (error instanceof ProviderCallBudgetError) {
        return this.#finish(telemetry, createRetrievalResult(claim.claimId, {
          status: 'insufficient_evidence',
          warnings: ['provider_call_budget_exhausted'],
        }))
      }
      return this.#finish(telemetry, resultForError(claim.claimId, error))
    }
  }

  async close() {
    await this.client.close?.()
  }
}
