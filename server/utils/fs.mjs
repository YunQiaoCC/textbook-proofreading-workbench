import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true })
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

export async function atomicWriteJson(filePath, value) {
  await ensureDirectory(path.dirname(filePath))
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function removeDirectory(directoryPath) {
  await rm(directoryPath, { recursive: true, force: true })
}
