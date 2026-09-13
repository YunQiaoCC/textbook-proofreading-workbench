#!/usr/bin/env node
import {
  assertScreeningShape,
  locationGate,
  normalizeScreeningTransport,
  screeningInstructions,
  STAGE1_MAX_OUTPUT_TOKENS,
} from '../server/ai/aiReviewRuntimeService.mjs'
import { DeepSeekResponsesClient } from '../server/ai/deepseekResponsesClient.mjs'
import { SCREENING_TRANSPORT_SCHEMA } from '../server/ai/deepseekTransportSchemas.mjs'
import { loadLegalSkillPrompt } from '../server/ai/legalSkillPrompt.mjs'

const client = new DeepSeekResponsesClient()
const model = client.getStatus().model
const bundle = {
  documentId: 'synthetic-screening-schema-smoke',
  chapterId: 'synthetic-chapter',
  startPdfPage: 1,
  endPdfPage: 1,
  pages: [{
    pdfPage: 1,
    extractionStatus: 'available',
    extractionReliability: 'high',
    blocks: [{ blockId: 'synthetic-block-1', text: '合同依法成立即必然生效。' }],
  }],
  coverage: { totalPages: 1, readyPages: 1, suspiciousPages: 0, unavailablePages: 0, blankPages: 0, coveredTextPages: 1, complete: true },
  characterCount: 13,
}

let status = 'not_sent'
let structuredOutputValid = false
let findingCount = 0
let upstreamErrorCategory = 'none'
let usage = {}

if (!client.getStatus().configured) {
  status = 'deepseek_unconfigured'
  process.exitCode = 2
} else {
  try {
    const skill = await loadLegalSkillPrompt()
    const result = await client.requestStructured({
      instructions: screeningInstructions(skill.policy),
      input: JSON.stringify({ chapter: bundle }),
      schema: SCREENING_TRANSPORT_SCHEMA,
      schemaName: 'legal_textbook_screening',
      reasoningEffort: 'low',
      maxOutputTokens: STAGE1_MAX_OUTPUT_TOKENS,
    })
    usage = result.usage ?? {}
    const findings = assertScreeningShape(normalizeScreeningTransport(result.data))
    locationGate(bundle, findings)
    findingCount = findings.length
    structuredOutputValid = true
    status = 'completed'
  } catch (error) {
    status = error?.code ?? 'deepseek_provider_error'
    upstreamErrorCategory = error?.upstreamErrorCategory ?? 'none'
    usage = error?.usage ?? {}
    process.exitCode = 1
  }
}

console.log(`model=${model}`)
console.log(`status=${status}`)
console.log(`structured_output_valid=${structuredOutputValid ? 'yes' : 'no'}`)
console.log(`finding_count=${findingCount}`)
console.log(`upstream_error_category=${upstreamErrorCategory}`)
console.log(`usage=${JSON.stringify(usage)}`)
