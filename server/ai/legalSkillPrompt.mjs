import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const LEGAL_SKILL_VERSION = '0.1'
export const LEGAL_SKILL_FILES = Object.freeze([
  'SKILL.md',
  'legal_rubric.md',
  'citation_policy.md',
  'uncertainty_policy.md',
  'output_contract.md',
])

export async function loadLegalSkillPrompt(root = path.resolve(import.meta.dirname, '..', '..', 'skills', 'legal-textbook-proofreading')) {
  const parts = []
  const hash = createHash('sha256')
  for (const file of LEGAL_SKILL_FILES) {
    const content = await readFile(path.join(root, file), 'utf8')
    hash.update(file).update('\0').update(content).update('\0')
    parts.push(`# ${file}\n\n${content}`)
  }
  return {
    skillVersion: LEGAL_SKILL_VERSION,
    skillHash: hash.digest('hex'),
    policy: parts.join('\n\n'),
  }
}
