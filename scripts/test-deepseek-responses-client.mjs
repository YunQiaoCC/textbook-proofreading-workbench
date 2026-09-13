#!/usr/bin/env node
import { strict as assert } from 'node:assert'
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

async function expectCode(name, response, code) {
  await test(name, async () => assert.rejects(new DeepSeekResponsesClient({ apiKey: 'sensitive', fetch: async () => response }).requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }), (error) => error instanceof DeepSeekProviderError && error.code === code && !JSON.stringify(error).includes('sensitive')))
}
await expectCode('http-401-sanitized', { ok: false, status: 401 }, 'deepseek_auth_error')
await expectCode('http-429-sanitized', { ok: false, status: 429 }, 'deepseek_rate_limited')
await expectCode('http-5xx-sanitized', { ok: false, status: 503 }, 'deepseek_provider_error')
await expectCode('incomplete-rejected', { ok: true, status: 200, async json() { return { status: 'incomplete', output: [], usage: {} } } }, 'deepseek_output_incomplete')
await expectCode('failed-rejected', { ok: true, status: 200, async json() { return { status: 'failed', output: [] } } }, 'deepseek_provider_error')
await expectCode('malformed-json-output-rejected', { ok: true, status: 200, async json() { return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] } } }, 'deepseek_output_invalid')
await expectCode('malformed-http-json-rejected', { ok: true, status: 200, async json() { throw new Error('bad') } }, 'deepseek_bad_response')
await test('timeout-sanitized', async () => {
  const timeoutClient = new DeepSeekResponsesClient({ apiKey: 'x', timeoutMs: 5, fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) })
  await assert.rejects(timeoutClient.requestStructured({ instructions: '', input: '', schema, schemaName: 'x', reasoningEffort: 'low', maxOutputTokens: 1 }), (error) => error.code === 'deepseek_timeout')
})
assert.equal(count, 22)
console.log(`deepseek-client-test-count=${count}`)
