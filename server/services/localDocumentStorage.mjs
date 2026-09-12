import { access, link, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createReadStream as openReadStream, createWriteStream } from 'node:fs'
import { ensureDirectory } from '../utils/fs.mjs'

function isSafeSegment(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(value)
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export class LocalDocumentStorage {
  constructor(storageRoot) {
    this.storageRoot = path.resolve(storageRoot)
    this.documentsRoot = path.join(this.storageRoot, 'documents')
  }

  async init() {
    await ensureDirectory(this.documentsRoot)
  }

  documentDirectory(documentId) {
    if (!isSafeSegment(documentId)) throw new Error('Invalid document identifier')
    const directory = path.resolve(this.documentsRoot, documentId)
    if (!isWithinRoot(this.documentsRoot, directory)) {
      throw new Error('Document directory escapes local storage root')
    }
    return directory
  }

  async removeDocument(documentId) {
    await rm(this.documentDirectory(documentId), { recursive: true, force: true })
  }

  absolutePathForKey(storageKey) {
    if (typeof storageKey !== 'string' || path.isAbsolute(storageKey)) {
      throw new Error('Storage key must be relative')
    }
    const absolutePath = path.resolve(this.storageRoot, storageKey)
    if (!isWithinRoot(this.storageRoot, absolutePath)) {
      throw new Error('Storage key escapes local storage root')
    }
    return absolutePath
  }

  resolveAbsolutePath(asset) {
    return this.absolutePathForKey(asset.storageKey)
  }

  async storeOriginalPdf({ documentId, byteSize, sha256, content }) {
    if (!isSafeSegment(documentId)) throw new Error('Invalid document identifier')
    if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Invalid SHA-256')
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0) throw new Error('Invalid PDF byte size')

    const relativeDirectory = path.join('documents', documentId, 'original')
    const finalStorageKey = path.join(relativeDirectory, `${sha256.toLowerCase()}.pdf`).split(path.sep).join('/')
    const finalPath = this.absolutePathForKey(finalStorageKey)
    await ensureDirectory(path.dirname(finalPath))

    const temporaryPath = `${finalPath}.${randomUUID()}.uploading`
    const hash = createHash('sha256')
    let receivedBytes = 0
    const digestTransform = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    try {
      await pipeline(
        Readable.from(content),
        digestTransform,
        createWriteStream(temporaryPath, { flags: 'wx' }),
      )
      const actualSha256 = hash.digest('hex')
      if (receivedBytes !== byteSize || actualSha256 !== sha256.toLowerCase()) {
        throw new Error('Stored PDF checksum or byte size mismatch')
      }

      try {
        await link(temporaryPath, finalPath)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = await stat(finalPath)
        if (existing.size !== byteSize) throw new Error('Immutable PDF asset collision')
      }
      await rm(temporaryPath, { force: true })
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }

    return {
      id: randomUUID(),
      documentId,
      kind: 'original-pdf',
      storageKey: finalStorageKey,
      mediaType: 'application/pdf',
      byteSize,
      sha256: sha256.toLowerCase(),
      createdAt: new Date().toISOString(),
      immutable: true,
    }
  }

  read(asset, options = {}) {
    return openReadStream(this.resolveAbsolutePath(asset), options)
  }

  async exists(asset) {
    try {
      await access(this.resolveAbsolutePath(asset))
      return true
    } catch {
      return false
    }
  }
}
