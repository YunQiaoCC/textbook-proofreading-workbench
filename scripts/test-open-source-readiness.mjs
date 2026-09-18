#!/usr/bin/env node

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(path.join(root, file), 'utf8')
const packageJson = JSON.parse(read('package.json'))
const packageLock = JSON.parse(read('package-lock.json'))
const gitignore = read('.gitignore')
const envExample = read('.env.example')
const readme = read('README.md')
const notice = read('NOTICE')
const license = read('LICENSE')
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean)

assert.equal(packageJson.name, 'legal-textbook-proofreading-workbench')
assert.equal(packageJson.version, '0.1.0')
assert.equal(packageJson.private, true)
assert.equal(packageLock.name, packageJson.name)
assert.equal(packageLock.version, packageJson.version)
assert.equal(packageLock.packages[''].name, packageJson.name)
assert.equal(packageLock.packages[''].version, packageJson.version)
assert.equal(existsSync(path.join(root, 'pnpm-lock.yaml')), false)
assert.equal(existsSync(path.join(root, 'yarn.lock')), false)

for (const requiredRule of [
  '.env', '.env.*', '!.env.example', '*.key', '*.pem', '*.p12', '*.pfx',
  '*.log', '*.db', '*.sqlite', '*.sqlite3', '*.bak', '*.tmp', 'Thumbs.db',
  '.DS_Store', 'node_modules/', 'dist/', '.vscode/', '.idea/', 'storage/', 'backups/',
]) {
  assert.ok(gitignore.split(/\r?\n/u).includes(requiredRule), `missing ignore rule: ${requiredRule}`)
}
assert.equal(gitignore.split(/\r?\n/u).includes('package-lock.json'), false)

assert.match(license, /Copyright \(c\) 2026 Laomai/u)
assert.match(license, /Modifications Copyright \(c\) 2026 YunQiaoCC/u)
assert.match(notice, /based on inklayer-vue-starter/u)
assert.match(notice, /Neither Laomai nor InkLayer endorses/u)
assert.match(readme, /AI does not automatically modify a PDF/u)
assert.match(readme, /human reviewer retains final authority/u)
assert.match(readme, /Skill and evals are part of this open-source project/u)

const privateIdentifierNeedles = [
  ['ky', 'cloudmimi'].join(''),
  ['150', '109', '70', '202'].join('.'),
  ['/', 'home', '/', 'ubuntu'].join(''),
  ['C:', '\\', 'Users', '\\'].join(''),
]
const assertNoPrivateIdentifiers = (value, label) => {
  for (const needle of privateIdentifierNeedles) {
    assert.equal(value.toLowerCase().includes(needle.toLowerCase()), false, `${label}: ${needle}`)
  }
}
assertNoPrivateIdentifiers(envExample, '.env.example')
assert.doesNotMatch(envExample, /(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}/u)

const forbiddenExtensions = /\.(?:pdf|docx?|xlsx?|pptx?|db|sqlite3?|bak|zip|7z|rar|tar|tgz|pem|key|p12|pfx)$/iu
assert.deepEqual(tracked.filter((file) => forbiddenExtensions.test(file)), [])
const images = tracked.filter((file) => /\.(?:png|jpe?g|webp|gif|svg)$/iu.test(file))
assert.deepEqual(images, ['public/favicon.svg'])

const filesForIdentifierScan = tracked.filter((file) => {
  const extension = path.extname(file).toLowerCase()
  return !extension || ['.md', '.mjs', '.js', '.ts', '.vue', '.json', '.sh', '.service', '.timer', '.example', '.html', '.svg'].includes(extension)
})
for (const file of filesForIdentifierScan) {
  const value = read(file)
  assertNoPrivateIdentifiers(value, file)
}

for (const file of tracked.filter((name) => /^scripts\/fixtures\/yuandian-.*-observed\.mjs$/u.test(name))) {
  const fixture = read(file)
  assert.match(fixture, /Synthetic shape-only fixture/u, `missing synthetic fixture marker in ${file}`)
  assert.doesNotMatch(fixture, /https?:\/\/(?!example\.invalid)[^'"\s]+/u, `non-synthetic URL in ${file}`)
  assert.ok(fixture.length < 8_000, `fixture is unexpectedly large: ${file}`)
}

console.log('open-source-readiness=pass')
