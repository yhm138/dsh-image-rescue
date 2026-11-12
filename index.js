/**
 * dsh-image-rescue — keep oversized images usable instead of rejecting the prompt.
 *
 * The Host attachment pipeline refuses the whole prompt when any source image
 * exceeds the deployment's byte / total-pixel / per-side pixel limits, which
 * makes a normal "turn these scans into a PDF" request impossible even though
 * the model could work with the files.
 *
 * This Host plugin wraps `ctx.attachments.admitPromptContent`:
 *
 *  - images that fit are admitted exactly as before (the original method runs
 *    first, so a normal prompt is unchanged and pays no extra decode);
 *  - images that would be refused are stored byte-for-byte through
 *    `saveFile`, and the model receives the durable file handle line with the
 *    read-only path of the untouched original, plus one short note. It can then
 *    view the image with `read_image` or convert it at full resolution with its
 *    own tools — no resampling, no re-encode, no truncation.
 *
 * Nothing is modified on disk: the rescued object is the exact submitted bytes
 * and is content-addressed by the attachment backend like any other file.
 *
 * @module dsh-image-rescue
 */

import { Buffer } from 'node:buffer'

/** Stable image-admission failures that indicate a limit rather than corruption. */
const RESCUE_ERROR_CODES = new Set([
  'TOO_MANY_IMAGES',
  'IMAGES_TOO_LARGE',
  'IMAGE_TOO_LARGE',
  'IMAGE_TOO_MANY_PIXELS',
  'IMAGE_DIMENSION_TOO_LARGE',
])

/** Marks the method this plugin installed, so a reload never stacks two wrappers. */
const WRAPPED_BY_US = Symbol.for('dsh-image-rescue:wrapped')

/** Media type to a file extension used when the upload carries no name. */
const MEDIA_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

const DEFAULT_NOTE = [
  '〔原图保留〕{name}（{dimensions}，{size}）超过视觉尺寸上限 {limit}px，',
  '已按原始字节原样保存为文件（未压缩、未转码）。',
  '上面的文件引用就是原图路径：查看可用 read_image，转换或处理直接使用该路径。',
].join('')

/**
 * Whether one attachment failure is an admission limit this plugin can rescue.
 * @param error - value caught from the attachment service.
 * @returns whether the failure is a rescuable image limit.
 */
function isRescuable(error) {
  return error instanceof Error && typeof error.code === 'string' && RESCUE_ERROR_CODES.has(error.code)
}

/**
 * Decode the wire image payload (canonical base64) into exact bytes.
 * @param data - base64 text or already-decoded bytes.
 * @returns the submitted bytes.
 */
function decodeImageData(data) {
  if (data instanceof Uint8Array) return data
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'base64'))
  throw new TypeError('image-rescue: image payload carries no bytes')
}

/**
 * Read only the intrinsic dimensions from an encoded raster header. Best
 * effort: the note omits dimensions when a format is not recognized.
 * @param bytes - encoded image bytes.
 * @returns width and height, or undefined when unknown.
 */
function probeImageSize(bytes) {
  try {
    // PNG: signature, then IHDR width/height as big-endian uint32.
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
    }
    // GIF: logical screen descriptor, little-endian uint16.
    if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
    }
    // JPEG: walk segments until a start-of-frame marker.
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = bytes[offset + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        if (marker === 0xd9 || marker === 0xda) break
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
        if (length < 2) break
        const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isStartOfFrame) {
          return { width: (bytes[offset + 7] << 8) | bytes[offset + 8], height: (bytes[offset + 5] << 8) | bytes[offset + 6] }
        }
        offset += 2 + length
      }
      return undefined
    }
    // WebP: RIFF container with a VP8X / VP8 / VP8L first chunk.
    if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
      if (chunk === 'VP8X') return { width: 1 + readU24LE(bytes, 24), height: 1 + readU24LE(bytes, 27) }
      if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff }
      }
      if (chunk === 'VP8L' && bytes[20] === 0x2f) {
        const b0 = bytes[21]
        const b1 = bytes[22]
        const b2 = bytes[23]
        const b3 = bytes[24]
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        }
      }
    }
  } catch {
    /* malformed header: fall through to the unnamed note */
  }
  return undefined
}

/** Big-endian uint32 at offset. */
function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/** Little-endian 24-bit integer at offset. */
function readU24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

/** Human-readable byte text for one byte count (`24B`, `321KB`, `2.5MB`). */
function sizeText(bytes) {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)}KB`
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}

/** Leaf file name for the rescued object; the backend sanitizes it anyway. */
function rescuedName(part, ordinal) {
  if (typeof part.name === 'string' && part.name.trim() !== '') return part.name
  return `image-${ordinal}.${MEDIA_EXTENSIONS[part.mediaType] ?? 'bin'}`
}

/** Note text for one rescued image, or undefined when notes are disabled. */
function noteText(note, part, bytes, ordinal, limit) {
  if (note === false) return undefined
  const size = probeImageSize(bytes)
  const dimensions = size === undefined ? sizeText(bytes.byteLength) : `${size.width}×${size.height}`
  const template = typeof note === 'string' && note.length > 0 ? note : DEFAULT_NOTE
  return template
    .replaceAll('{name}', rescuedName(part, ordinal))
    .replaceAll('{dimensions}', dimensions)
    .replaceAll('{size}', sizeText(bytes.byteLength))
    .replaceAll('{limit}', String(limit ?? 8192))
}

/**
 * Renormalize one prompt after the untouched admission refused it: keep every
 * image that fits, store every limited image verbatim as a file.
 * @param store - live attachment service.
 * @param content - original prompt parts.
 * @param original - original admission failure, rethrown when nothing can be rescued.
 * @param options - normalized plugin options.
 * @returns admitted prompt parts in the original order.
 */
async function rescuePrompt(store, content, original, options) {
  const limits = store.imageLimits ?? {}
  const triaged = []
  let imageCount = 0
  let imageBytes = 0
  let rescuedCount = 0

  for (const part of content) {
    if (part === null || typeof part !== 'object') throw original
    if (part.type === 'text') {
      triaged.push({ kind: 'text', part })
      continue
    }
    if (part.type === 'file') {
      triaged.push({ kind: 'file', part })
      continue
    }
    if (part.type !== 'image') throw original

    const bytes = decodeImageData(part.data)
    const input = { data: bytes, mediaType: part.mediaType, ...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}) }
    const mediaTypes = Array.isArray(limits.mediaTypes) ? limits.mediaTypes : undefined

    if (mediaTypes !== undefined && !mediaTypes.includes(part.mediaType)) {
      triaged.push({ kind: 'rescue', part, bytes, reason: 'IMAGE_TYPE_UNSUPPORTED' })
      continue
    }
    if (typeof limits.maxImageBytes === 'number' && bytes.byteLength > limits.maxImageBytes) {
      triaged.push({ kind: 'rescue', part, bytes, reason: 'IMAGE_TOO_LARGE' })
      continue
    }
    if (typeof limits.maxImagesPerMessage === 'number' && imageCount + 1 > limits.maxImagesPerMessage) {
      triaged.push({ kind: 'rescue', part, bytes, reason: 'TOO_MANY_IMAGES' })
      continue
    }
    if (typeof limits.maxMessageImageBytes === 'number' && imageBytes + bytes.byteLength > limits.maxMessageImageBytes) {
      triaged.push({ kind: 'rescue', part, bytes, reason: 'IMAGES_TOO_LARGE' })
      continue
    }
    try {
      await store.validateImage(input)
    } catch (error) {
      if (!isRescuable(error)) throw error
      triaged.push({ kind: 'rescue', part, bytes, reason: error.code })
      continue
    }
    imageCount += 1
    imageBytes += bytes.byteLength
    triaged.push({ kind: 'keep', part, bytes })
  }

  const admitted = []
  for (const item of triaged) {
    if (item.kind === 'text') {
      admitted.push({ type: 'text', text: item.part.text })
      continue
    }
    if (item.kind === 'file') {
      admitted.push({ type: 'file', attachment: item.part.attachment })
      continue
    }
    if (item.kind === 'keep') {
      const input = { data: item.bytes, mediaType: item.part.mediaType, ...(typeof item.part.name === 'string' && item.part.name !== '' ? { name: item.part.name } : {}) }
      admitted.push({ type: 'image', attachment: await store.saveImage(input) })
      continue
    }

    rescuedCount += 1
    let ref
    try {
      ref = await store.saveFile({ data: item.bytes, name: rescuedName(item.part, rescuedCount) })
    } catch {
      // No verbatim file storage on this backend: the prompt cannot be admitted.
      throw original
    }
    admitted.push({ type: 'file', attachment: ref })
    const note = noteText(options.note, item.part, item.bytes, rescuedCount, limits.maxImageDimension)
    if (note !== undefined) admitted.push({ type: 'text', text: note })
  }

  if (rescuedCount === 0) throw original
  return admitted
}

/** Normalize raw bundle config into the options this plugin understands. */
function normalizeOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: raw.enabled !== false,
    note: raw.note === undefined ? DEFAULT_NOTE : raw.note,
  }
}

/**
 * Wrap one attachment service instance. Exported for tests and for hosts that
 * mount the service after this plugin's own context.
 *
 * Cordis hands out a fresh traceable proxy on every `ctx.<service>` access, and
 * those proxies wrap function values again, so neither the service object nor
 * the method keeps a stable identity. The wrapper is therefore marked on the
 * function itself and looked up through the target's own property descriptor.
 *
 * @param store - attachment service instance implementing the standard contract.
 * @param config - raw plugin config.
 * @returns a disposer restoring the original method, or undefined when the
 * service cannot be wrapped.
 */
export function wrapAttachmentStore(store, config) {
  if (store === null || typeof store !== 'object') return undefined
  const options = normalizeOptions(config)
  if (!options.enabled) return undefined
  const own = ownMethod(store)
  if (own?.value?.[WRAPPED_BY_US] === true) return undefined
  const original = own?.value ?? store.admitPromptContent
  if (typeof original !== 'function') return undefined
  const restoreAsOwn = own !== undefined

  const wrapped = async function admitPromptContentWithRescue(content) {
    if (!Array.isArray(content) || !content.some((part) => part !== null && typeof part === 'object' && part.type === 'image')) {
      return original.call(this, content)
    }
    try {
      return await original.call(this, content)
    } catch (error) {
      if (!isRescuable(error)) throw error
      return await rescuePrompt(this, content, error, options)
    }
  }
  wrapped[WRAPPED_BY_US] = true

  try {
    store.admitPromptContent = wrapped
  } catch {
    return undefined
  }

  return () => {
    if (ownMethod(store)?.value !== wrapped) return
    try {
      // A Cordis service keeps the method on its prototype, so deleting the own
      // property restores native behavior. A plain object owns it: assign it back.
      if (restoreAsOwn) store.admitPromptContent = original
      else delete store.admitPromptContent
    } catch {
      /* keep the wrapper rather than lose the original */
    }
  }
}

/** Own `admitPromptContent` property of the service target, if any. */
function ownMethod(store) {
  try {
    return Object.getOwnPropertyDescriptor(store, 'admitPromptContent')
  } catch {
    return undefined
  }
}

/** @type {string[]} */
export const inject = ['attachments']

/**
 * Mount the rescue wrapper on the live attachment service and follow service
 * replacements (plugin reloads) for as long as this plugin is mounted.
 * @param ctx - Host plugin context.
 * @param config - raw bundle config: `enabled` (default true) and `note`
 *   (default a Chinese one-liner; `false` disables the note text).
 */
export function apply(ctx, config) {
  const disposers = new Map()
  const patch = (store) => {
    if (store === null || store === undefined) return
    if (disposers.has(store)) return
    const dispose = wrapAttachmentStore(store, config)
    if (dispose !== undefined) disposers.set(store, dispose)
  }

  ctx.effect(() => {
    patch(ctx.attachments)
    return () => {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
    }
  })

  ctx.on('internal/service', (name, service) => {
    if (name === 'attachments' && service !== null && service !== undefined) patch(service)
  })
}
