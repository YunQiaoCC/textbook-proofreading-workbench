#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { createDeepSeekConfig, DeepSeekProviderError, DeepSeekResponsesClient } from '../server/ai/deepseekResponsesClient.mjs'

let count = 0
async function test(name, operation) { await operation(); count += 1; console.log(`${name}=pass`) }
const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
const completed = (body = { ok: true }) => ({
  ok: true, status: 200,
  async json() { return { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'private reasoning' }] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } } },
})

await test('configured', () => assert.equal(createDeepSeekConfig({ apiKey: 'secret' }).configured, true))
await test('unconfigured', () => assert.equal(createDeepSeekConfig({ env: {} }).configured, false))
await test('default-model', () => assert.equal(createDeepSeekConfig({ apiKey: 'x' }).model, 'deepseek-v4-flash'))
await test('unconfigured-rejected', async () => assert.rejects(new DeepSeekResponsesClient({ config: createDeepSeekConfig({ env: {} }), fetch: async () => completed() }).requestStructured({}), (error) => error.code === 'deepseek_unconfigured'))

let captured
const client = new DeepSeekResponsesClient({ apiKey: 'never-log-this-key', fetch: async (url, options) => { captured = { url, options }; return completed() } })
const result = await client.requestStructured({ instructions: 'policy', input: 'fixture', schema, schemaName: 'fixture_schema', reasoningEffort: 'low', maxOutputTokens: 321 })
await test('responses-endpoint', () => assert.equal(captured.url, 'https://api.deepseek.com/responses'))
await test('authorization-header', () => assert.equal(captured.options.headers.authorization, 'Bearer never-log-this-key'))
await test('payload-model', () => assert.equal(JSON.parse(captured.options.body).model, 'deepseek-v4-flash'))
await test('payload-effort', () => assert.equal(JSON.parse(captured.options.body).reasoning.effort, 'low'))
await test('payload-json-schema', () => assert.deepEqual(JSON.parse(captured.options.body).text.format.schema, schema))
await test('payload-token-limit', () => assert.equal(JSON.parse(captured.options.body).max_output_tokens, 321))
await test('no-temperature-top-p', () => { const body = JSON.parse(captured.options.body); assert.equal('temperature' in body, false); assert.equal('top_p' in body, false) })
await test('structured-response-parsed', () => assert.deepEqual(result.data, { ok: true }))
await test('reasoning-ignored', () => assert.equal(JSON.stringify(result).includes('private reasoning'), false))
await test('usage-parsed', () => assert.deepEqual(result.usage, { input_tokens: 11, cached_tokens: 3, output_tokens: 7, reasoning_tokens: 2, total_tokens: 18 }))

await test('http-400-schema-error-is-safely-categorized', async () => {
  const response = {
    ok: false,
    status: 400,
    async json() { return { error: { type: 'invalid_request_error', code: 'invalid_json_schema', message: 'ARBITRARY PROVIDER DETAIL MUST NOT ESCAPE' } } },
  }
  await assert.rejects(
    new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }),
    (error) => {
      assert.equal(error.code, 'deepseek_bad_response')
      assert.equal(error.upstreamErrorCategory, 'invalid_json_schema')
      assert.equal(error.upstreamErrorCode, 'invalid_json_schema')
      assert.equal(JSON.stringify(error).includes('ARBITRARY PROVIDER DETAIL'), false)
      return true
    },
  )
})
await test('arbitrary-provider-message-and-unsafe-code-are-discarded', async () => {
  const response = {
    ok: false,
    status: 400,
    async json() { return { error: { code: 'unsafe code containing spaces and provider detail', message: 'unclassified arbitrary detail' } } },
  }
  await assert.rejects(
    new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }),
    (error) => {
      assert.equal(error.upstreamErrorCategory, 'unknown_bad_request')
      assert.equal(error.upstreamErrorCode, undefined)
      assert.equal(JSON.stringify(error).includes('arbitrary detail'), false)
      return true
    },
  )
})

async function expectCode(name, response, code) {
  await test(name, async () => assert.rejects(new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }), (error) => error instanceof DeepSeekProviderError && error.code === code && !JSON.stringify(error).includes('sensitive')))
}
await expectCode('http-401-sanitized', { ok: false, status: 401 }, 'deepseek_auth_error')
await expectCode('http-429-sanitized', { ok: false, status: 429 }, 'deepseek_rate_limited')
await expectCode('http-5xx-sanitized', { ok: false, status: 503 }, 'deepseek_provider_error')
await expectCode('incomplete-rejected', { ok: true, status: 200, async json() { return { status: 'incomplete', output: [], usage: {} } } }, 'deepseek_output_incomplete')
await expectCode('failed-rejected', { ok: true, status: 200, async json() { return { status: 'failed', output: [] } } }, 'deepseek_provider_error')
await test('completed-without-output-text-is-safely-categorized', async () => {
  const response = {
    ok: true,
    status: 200,
    async json() {
      return {
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ text: 'PRIVATE REASONING MUST NOT ESCAPE' }] },
          { type: 'message', content: [{ type: 'refusal', text: 'PRIVATE CONTENT MUST NOT ESCAPE' }] },
          { type: 'unsafe type containing provider text', content: [] },
        ],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }
    },
  }
  await assert.rejects(
    new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }),
    (error) => {
      assert.equal(error.code, 'deepseek_output_invalid')
      assert.equal(error.outputInvalidCategory, 'missing_output_text')
      assert.equal(error.responseStatus, 200)
      assert.deepEqual(error.outputItemTypes, ['message', 'reasoning'])
      assert.deepEqual(error.contentTypes, ['refusal'])
      assert.equal(error.outputTextLength, undefined)
      assert.equal(error.outputTextSha256, undefined)
      const serialized = JSON.stringify(error)
      assert.equal(serialized.includes('PRIVATE REASONING'), false)
      assert.equal(serialized.includes('PRIVATE CONTENT'), false)
      assert.equal(serialized.includes('unsafe type containing provider text'), false)
      return true
    },
  )
})
await test('malformed-json-output-is-safely-categorized', async () => {
  const malformed = '{bad PRIVATE OUTPUT MUST NOT ESCAPE'
  const response = {
    ok: true,
    status: 200,
    async json() {
      return {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: malformed }] }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      }
    },
  }
  await assert.rejects(
    new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }),
    (error) => {
      assert.equal(error.code, 'deepseek_output_invalid')
      assert.equal(error.outputInvalidCategory, 'invalid_json')
      assert.equal(error.responseStatus, 200)
      assert.deepEqual(error.outputItemTypes, ['message'])
      assert.deepEqual(error.contentTypes, ['output_text'])
      assert.equal(error.outputTextLength, malformed.length)
      assert.equal(error.outputTextSha256, createHash('sha256').update(malformed, 'utf8').digest('hex'))
      assert.equal(JSON.stringify(error).includes(malformed), false)
      return true
    },
  )
})
await expectCode('malformed-http-json-rejected', { ok: true, status: 200, async json() { throw new Error('bad') } }, 'deepseek_bad_response')
await test('timeout-sanitized', async () => {
  const timeoutClient = new DeepSeekResponsesClient({ apiKey: 'x', timeoutMs: 5, fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) })
  await assert.rejects(timeoutClient.requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }), (error) => error.code === 'deepseek_timeout')
})
assert.equal(count, 25)
console.log(`deepseek-client-test-count=${count}`)
