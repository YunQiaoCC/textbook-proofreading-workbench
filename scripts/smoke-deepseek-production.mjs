#!/usr/bin/env node
import { DeepSeekResponsesClient } from '../server/ai/deepseekResponsesClient.mjs'

const client = new DeepSeekResponsesClient()
const status = client.getStatus()
console.log(`configured=${status.configured ? 'yes' : 'no'}`)
console.log(`model=${status.model}`)
if (!status.configured) process.exitCode = 2
else {
  try {
    const result = await client.requestStructured({
      instructions: 'Return a conservative structured classification. Do not add facts.',
      input: 'Synthetic public fixture: “本法自公布之日起施行。” Classify whether the sentence is syntactically complete.',
      schemaName: 'deepseek_smoke', reasoningEffort: 'low', maxOutputTokens: 256,
      schema: { type: 'object', additionalProperties: false, required: ['valid'], properties: { valid: { type: 'boolean' } } },
    })
    console.log('http/status_category=completed')
    console.log(`structured_output_valid=${typeof result.data?.valid === 'boolean' ? 'yes' : 'no'}`)
    console.log(`usage=${JSON.stringify(result.usage ?? {})}`)
  } catch (error) {
    console.log(`http/status_category=${error.code ?? 'deepseek_provider_error'}`)
    console.log('structured_output_valid=no')
    console.log(`usage=${JSON.stringify(error.usage ?? {})}`)
    process.exitCode = 1
  }
}
