import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { projectRoot } from '../config.mjs'
import { ensureDirectory } from '../utils/fs.mjs'

const MAX_OUTPUT = 32 * 1024

function runInspectionCli({ scriptPath, filePath, reportPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, filePath, '--json', reportPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`PDF inspection exceeded ${timeoutMs}ms`))
    }, timeoutMs)

    const capture = (target, chunk) => {
      const text = chunk.toString('utf8')
      return target.length >= MAX_OUTPUT
        ? target
        : `${target}${text.slice(0, MAX_OUTPUT - target.length)}`
    }

    child.stdout.on('data', (chunk) => {
      stdout = capture(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capture(stderr, chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`PDF inspection failed (code=${code}, signal=${signal}): ${stderr || stdout}`))
    })
  })
}

export class PopplerInspectionService {
  constructor({ storageRoot, timeoutMs }) {
    this.reportRoot = path.join(storageRoot, 'temp', 'inspection')
    this.timeoutMs = timeoutMs
  }

  async init() {
    await ensureDirectory(this.reportRoot)
  }

  async inspect(filePath) {
    const reportPath = path.join(this.reportRoot, `${randomUUID()}.json`)
    try {
      await runInspectionCli({
        scriptPath: path.join(projectRoot, 'scripts', 'inspect-pdf.mjs'),
        filePath,
        reportPath,
        timeoutMs: this.timeoutMs,
      })
      return JSON.parse(await readFile(reportPath, 'utf8'))
    } finally {
      await rm(reportPath, { force: true })
    }
  }
}
