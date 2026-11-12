import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

import { apply, inject, wrapAttachmentStore } from '../index.js'

const LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
})

/** Bytes whose first byte marks an oversized image for the fake store. */
function bytes(seed, oversized = false) {
  const data = new Uint8Array(16 + seed)
  data.fill(seed)
  if (oversized) data[0] = 0xff
  return data
}

function base64(data) {
  return Buffer.from(data).toString('base64')
}

/** In-memory attachment store with the same contract the Host service exposes. */
function fakeStore(options = {}) {
  const saved = { images: [], files: [], validations: 0, originalCalls: 0 }
  const store = {
    imageLimits: { ...LIMITS, ...(options.limits ?? {}) },
    async validateImage(input) {
      saved.validations += 1
      if (options.validationError !== undefined) throw options.validationError
      if (options.oversizedMediaType === input.mediaType) throw limitError('IMAGE_TYPE_MISMATCH')
      if (input.data[0] === 0xff) throw limitError('IMAGE_DIMENSION_TOO_LARGE')
      if (input.data[0] === 0xfe) throw limitError('INVALID_IMAGE')
    },
    async saveImage(input) {
      saved.images.push(input)
      return { attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`, mediaType: input.mediaType, width: 10, height: 10, bytes: input.data.byteLength }
    },
    async saveFile(input) {
      if (options.noFileStorage === true) throw new Error('verbatim files unsupported')
      saved.files.push(input)
      return { attachmentId: `sha256:${createHash('sha256').update(input.data).digest('hex')}`, name: input.name, bytes: input.data.byteLength }
    },
    fileHostPath() {
      return 'C:/fake/files/object'
    },
    async admitPromptContent(content) {
      saved.originalCalls += 1
      const images = content.filter((part) => part.type === 'image')
      if (images.length > store.imageLimits.maxImagesPerMessage) throw limitError('TOO_MANY_IMAGES')
      const totalBytes = images.reduce((sum, part) => sum + Buffer.from(part.data, 'base64').byteLength, 0)
      if (totalBytes > store.imageLimits.maxMessageImageBytes) throw limitError('IMAGES_TOO_LARGE')
      for (const part of images) {
        const data = new Uint8Array(Buffer.from(part.data, 'base64'))
        if (data[0] === 0xff) throw limitError('IMAGE_DIMENSION_TOO_LARGE')
        if (data[0] === 0xfe) throw limitError(corruptCode(options))
      }
      let index = 0
      return content.map((part) => {
        if (part.type === 'image') return { type: 'image', attachment: { attachmentId: `sha256:image${index++}`, mediaType: part.mediaType, width: 10, height: 10, bytes: 16 } }
        if (part.type === 'file') return { type: 'file', attachment: part.attachment }
        return { type: 'text', text: part.text }
      })
    },
    isAttachmentError() {
      return true
    },
  }
  return { store, saved }
}

function limitError(code) {
  const error = new Error(code)
  error.name = 'AttachmentError'
  error.code = code
  return error
}

function corruptCode(options) {
  return options.corruptCode ?? 'INVALID_IMAGE'
}

function image(seed, { oversized = false, mediaType = 'image/jpeg', name } = {}) {
  return { type: 'image', mediaType, data: base64(bytes(seed, oversized)), ...(name === undefined ? {} : { name }) }
}

test('prompt without images is forwarded untouched', async () => {
  const { store, saved } = fakeStore()
  wrapAttachmentStore(store, {})
  const content = [{ type: 'text', text: 'hello' }]
  const out = await store.admitPromptContent(content)
  assert.deepEqual(out, [{ type: 'text', text: 'hello' }])
  assert.equal(saved.originalCalls, 1)
})

test('a prompt whose images all fit keeps the original behavior', async () => {
  const { store, saved } = fakeStore()
  wrapAttachmentStore(store, {})
  const out = await store.admitPromptContent([image(1), image(2)])
  assert.equal(saved.originalCalls, 1)
  assert.equal(out.length, 2)
  assert.ok(out.every((part) => part.type === 'image'))
  assert.equal(saved.files.length, 0)
})

test('an oversized image becomes a byte-exact file part plus one note', async () => {
  const { store, saved } = fakeStore()
  const dispose = wrapAttachmentStore(store, {})
  const oversized = bytes(5, true)
  const out = await store.admitPromptContent([image(5, { oversized: true, name: 'scan.jpg' }), image(6), { type: 'text', text: 'to pdf' }])
  assert.equal(out.length, 4)
  assert.equal(out[0].type, 'file')
  assert.equal(out[0].attachment.name, 'scan.jpg')
  assert.deepEqual(saved.files.at(-1).data, oversized)
  assert.equal(out[1].type, 'text')
  assert.match(out[1].text, /scan\.jpg/)
  assert.match(out[1].text, /8192/)
  assert.equal(out[2].type, 'image')
  assert.equal(out[3].type, 'text')
  dispose()
})

test('the note can be disabled or templated', async () => {
  const disabled = fakeStore()
  wrapAttachmentStore(disabled.store, { note: false })
  const withoutNote = await disabled.store.admitPromptContent([image(7, { oversized: true })])
  assert.equal(withoutNote.length, 1)
  assert.equal(withoutNote[0].type, 'file')

  const templated = fakeStore()
  wrapAttachmentStore(templated.store, { note: 'kept {name} at {dimensions}/{size} limit {limit}' })
  const withNote = await templated.store.admitPromptContent([image(8, { oversized: true, name: 'a.png' })])
  assert.equal(withNote[1].text, 'kept a.png at 24B/24B limit 8192')
})

test('corrupt images keep failing as before', async () => {
  const { store } = fakeStore()
  wrapAttachmentStore(store, {})
  const corrupt = { type: 'image', mediaType: 'image/jpeg', data: base64(new Uint8Array([0xfe])) }
  await assert.rejects(() => store.admitPromptContent([corrupt]), /INVALID_IMAGE/)
})

test('a backend without verbatim file storage keeps the native refusal', async () => {
  const { store } = fakeStore({ noFileStorage: true })
  wrapAttachmentStore(store, {})
  await assert.rejects(() => store.admitPromptContent([image(9, { oversized: true })]), /IMAGE_DIMENSION_TOO_LARGE/)
})

test('count overflow keeps the first images and rescues the rest', async () => {
  const { store } = fakeStore({ limits: { maxImagesPerMessage: 2 } })
  wrapAttachmentStore(store, {})
  const out = await store.admitPromptContent([image(1), image(2), image(3), image(4)])
  assert.equal(out.filter((part) => part.type === 'image').length, 2)
  assert.equal(out.filter((part) => part.type === 'file').length, 2)
})

test('aggregate byte overflow rescues the images that would exceed the budget', async () => {
  const { store } = fakeStore({ limits: { maxMessageImageBytes: 40 } })
  wrapAttachmentStore(store, {})
  const out = await store.admitPromptContent([image(10), image(11), image(12)])
  assert.equal(out.filter((part) => part.type === 'image').length, 1)
  assert.equal(out.filter((part) => part.type === 'file').length, 2)
})

test('dispose restores the original method so native refusals come back', async () => {
  const { store } = fakeStore()
  const dispose = wrapAttachmentStore(store, {})
  assert.equal(typeof dispose, 'function')
  dispose()
  await assert.rejects(() => store.admitPromptContent([image(1, { oversized: true })]), /IMAGE_DIMENSION_TOO_LARGE/)
})

test('wrapping twice is a no-op', async () => {
  const { store } = fakeStore()
  assert.equal(typeof wrapAttachmentStore(store, {}), 'function')
  assert.equal(wrapAttachmentStore(store, {}), undefined)
})

test('enabled:false leaves the store alone', async () => {
  const { store } = fakeStore()
  assert.equal(wrapAttachmentStore(store, { enabled: false }), undefined)
})

test('apply() wires the wrapper through the attachments service', async () => {
  const { store } = fakeStore()
  const disposers = []
  const ctx = {
    attachments: store,
    effect(setup) {
      disposers.push(setup())
    },
    on() {},
  }
  assert.deepEqual(inject, ['attachments'])
  apply(ctx, {})
  const out = await store.admitPromptContent([image(1, { oversized: true })])
  assert.equal(out[0].type, 'file')
  disposers.forEach((dispose) => dispose())
  await assert.rejects(() => store.admitPromptContent([image(1, { oversized: true })]), /IMAGE_DIMENSION_TOO_LARGE/)
})

test('package manifest declares the bundle and exports the metadata resources', () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(manifest.exports['./locale/*.json'])
  assert.ok(manifest.exports['./icon'])
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(manifest.files.includes('locale/*.json'))
  assert.ok(manifest.files.includes('icon.svg'))
})
