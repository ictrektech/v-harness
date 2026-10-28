/**
 * Minimal PNG cropping for the preview a card shows the model.
 *
 * The engine renders a whole document and exposes only `max_side`, so a caller
 * that wants to look at the eye it just enlarged receives the same picture as a
 * caller looking at the whole frame — at the same visual-token cost, with the
 * detail it cares about scaled away. Cropping here trades a little arithmetic
 * for that difference.
 *
 * Scope is deliberately narrow: the bytes come from the engine's own preview
 * encoder, so only 8-bit non-interlaced RGB/RGBA is supported. Anything else is
 * returned unchanged rather than guessed at.
 *
 * @module @deepseek-ai/dsh-skill-photocraft/png
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A crop window in fractions of the picture; values outside 0..1 are clamped. */
export interface PngFraction {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Decoded rows plus the header fields a re-encode must preserve. */
interface Decoded {
  width: number
  height: number
  /** PNG colour type: 2 = RGB, 6 = RGBA. */
  colorType: 2 | 6
  /** Bytes per pixel, derived from the colour type. */
  bpp: number
  /** Unfiltered scanlines, one after another. */
  pixels: Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC-32 over one chunk's type and data, as PNG requires. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One length-prefixed, CRC-terminated chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  typeBytes.copy(head, 4)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Read one PNG into unfiltered scanlines, or undefined when unsupported. */
function decode(bytes: Buffer): Decoded | undefined {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined
  let offset = 8
  let width = 0
  let height = 0
  let colorType: 2 | 6 = 6
  const parts: Buffer[] = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const kind = body[9]
      const interlace = body[12]
      // Anything beyond this file's own encoder is left alone: a wrong guess
      // would corrupt the preview rather than merely skip the crop.
      if (depth !== 8 || interlace !== 0 || (kind !== 2 && kind !== 6)) return undefined
      colorType = kind
    } else if (type === 'IDAT') {
      parts.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
  }
  if (width === 0 || height === 0 || parts.length === 0) return undefined
  const bpp = colorType === 6 ? 4 : 3
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(parts))
  } catch {
    return undefined
  }
  if (raw.length < height * (width * bpp + 1)) return undefined
  return { width, height, colorType, bpp, pixels: unfilter(raw, width, height, bpp) }
}

/** Reverse the per-scanline filters into plain pixel rows. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = y * stride
    const previous = row - stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? (out[row + x - bpp] ?? 0) : 0
      const above = y > 0 ? (out[previous + x] ?? 0) : 0
      const upperLeft = x >= bpp && y > 0 ? (out[previous + x - bpp] ?? 0) : 0
      let value = line[x] ?? 0
      if (filter === 1) value += left
      else if (filter === 2) value += above
      else if (filter === 3) value += (left + above) >> 1
      else if (filter === 4) {
        const estimate = left + above - upperLeft
        const toLeft = Math.abs(estimate - left)
        const toAbove = Math.abs(estimate - above)
        const toUpperLeft = Math.abs(estimate - upperLeft)
        value += toLeft <= toAbove && toLeft <= toUpperLeft ? left : toAbove <= toUpperLeft ? above : upperLeft
      }
      out[row + x] = value & 0xff
    }
  }
  return out
}

/** Encode unfiltered rows as a PNG of the same colour type. */
function encode(pixels: Buffer, width: number, height: number, colorType: 2 | 6): Buffer {
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    // Filter 0 keeps the encoder dumb; deflate still compresses the result.
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  header[10] = 0
  header[11] = 0
  header[12] = 0
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The pixel window a fraction rectangle selects, clamped to the picture. */
function windowOf(width: number, height: number, region: PngFraction): {
  left: number
  top: number
  right: number
  bottom: number
} {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  const left = Math.floor(clamp(region.x) * width)
  const top = Math.floor(clamp(region.y) * height)
  const right = Math.min(width, Math.ceil((clamp(region.x) + clamp(region.w)) * width))
  const bottom = Math.min(height, Math.ceil((clamp(region.y) + clamp(region.h)) * height))
  return {
    left: Math.min(left, Math.max(0, width - 1)),
    top: Math.min(top, Math.max(0, height - 1)),
    right: Math.max(right, left + 1),
    bottom: Math.max(bottom, top + 1),
  }
}

/**
 * Crop one preview to the rectangle the caller wants to look at.
 *
 * A rectangle that already covers the picture, a format this decoder does not
 * support, or bytes that are not a PNG all return the input unchanged: a crop
 * that cannot be trusted must never cost the caller its preview.
 * @param bytes - the preview PNG.
 * @param region - the window as fractions of the picture.
 * @returns the cropped PNG, or the original bytes.
 */
export function cropPng(bytes: Buffer, region: PngFraction): Buffer {
  const decoded = decode(bytes)
  if (decoded === undefined) return bytes
  const { width, height, bpp, colorType, pixels } = decoded
  const box = windowOf(width, height, region)
  const cropWidth = box.right - box.left
  const cropHeight = box.bottom - box.top
  if (cropWidth >= width && cropHeight >= height) return bytes
  if (cropWidth < 2 || cropHeight < 2) return bytes
  const stride = width * bpp
  const out = Buffer.alloc(cropWidth * cropHeight * bpp)
  for (let y = 0; y < cropHeight; y += 1) {
    const from = (box.top + y) * stride + box.left * bpp
    pixels.copy(out, y * cropWidth * bpp, from, from + cropWidth * bpp)
  }
  return encode(out, cropWidth, cropHeight, colorType)
}

/** Pixel size from the header alone, without decoding the image. */
export function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE)) return undefined
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * Scale one picture so its long edge lands on `longSide`.
 *
 * A closeup is only useful if the pixels it shows are large enough to judge: a
 * 200px crop shrunk to fit would waste the very detail the crop was taken for.
 * Bilinear keeps edges readable without the ringing a sharper kernel adds to
 * the artefacts the reader is looking for.
 * @param bytes - source PNG.
 * @param longSide - target length of the longer edge, in pixels.
 * @returns the scaled PNG, or the source when it cannot be decoded.
 */
export function fitPng(bytes: Buffer, longSide: number): Buffer {
  const decoded = decode(bytes)
  if (decoded === undefined) return bytes
  const { width, height, bpp, colorType, pixels } = decoded
  const scale = longSide / Math.max(width, height)
  if (scale <= 0) return bytes
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  if (targetWidth === width && targetHeight === height) return bytes
  const out = Buffer.alloc(targetWidth * targetHeight * bpp)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, (y + 0.5) * height / targetHeight - 0.5))
    const y0 = Math.floor(sourceY)
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = sourceY - y0
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, (x + 0.5) * width / targetWidth - 0.5))
      const x0 = Math.floor(sourceX)
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = sourceX - x0
      for (let channel = 0; channel < bpp; channel += 1) {
        const top = (pixels[(y0 * width + x0) * bpp + channel] ?? 0) * (1 - wx)
          + (pixels[(y0 * width + x1) * bpp + channel] ?? 0) * wx
        const bottom = (pixels[(y1 * width + x0) * bpp + channel] ?? 0) * (1 - wx)
          + (pixels[(y1 * width + x1) * bpp + channel] ?? 0) * wx
        out[(y * targetWidth + x) * bpp + channel] = Math.round(top * (1 - wy) + bottom * wy) & 0xff
      }
    }
  }
  return encode(out, targetWidth, targetHeight, colorType)
}

/**
 * Overlay a fine grid and a centre cross.
 *
 * "Move it 5px left" needs a ruler the reader can count, and a quarter grid is
 * far too coarse for a 200px window: at a 24px pitch a reader can estimate to
 * within a couple of pixels, which is the precision an edge judgement needs.
 * The cross marks the centre of the window, so a target that drifts shows up as
 * a shift rather than as an impression.
 * @param bytes - source PNG.
 * @param pitch - spacing of the grid, in pixels of the picture being annotated.
 * @returns the annotated PNG, or the source when it cannot be decoded.
 */
export function guidesPng(bytes: Buffer, pitch = 24): Buffer {
  const decoded = decode(bytes)
  if (decoded === undefined) return bytes
  const { width, height, bpp, colorType } = decoded
  const pixels = Buffer.from(decoded.pixels)
  const channels = colorType === 6 ? bpp : 3
  const blend = (x: number, y: number, value: number, alpha: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const index = (y * width + x) * bpp
    for (let channel = 0; channel < channels; channel += 1) {
      const base = pixels[index + channel] ?? 0
      pixels[index + channel] = Math.round(base * (1 - alpha) + value * alpha) & 0xff
    }
  }
  const step = Math.max(8, Math.round(pitch))
  // A faint grid marks intervals without hiding the pixels being judged.
  for (let x = step; x < width; x += step) {
    for (let y = 0; y < height; y += 1) blend(x, y, 255, 0.22)
  }
  for (let y = step; y < height; y += step) {
    for (let x = 0; x < width; x += 1) blend(x, y, 255, 0.22)
  }
  // The cross is two pixels wide and doubled (black over white) so it stays
  // legible on both a bright sky and a dark shadow.
  const centreX = Math.round(width / 2)
  const centreY = Math.round(height / 2)
  for (let y = 0; y < height; y += 1) {
    blend(centreX, y, 255, 0.5)
    blend(centreX + 1, y, 0, 0.5)
  }
  for (let x = 0; x < width; x += 1) {
    blend(x, centreY, 255, 0.5)
    blend(x, centreY + 1, 0, 0.5)
  }
  return encode(pixels, width, height, colorType)
}
