// 업로드 파일 판별과 비트맵 디코딩(안전 한도 적용)

export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** 처리 해상도 상한. 넘으면 비율을 유지해 축소 처리하고 좌표는 원본 크기로 되돌린다. */
export const MAX_PROCESS_PIXELS = 16_000_000
export const MAX_DECODE_SIDE = 20000

export type FileKind = 'bitmap' | 'svg'

export function detectKind(file: File): FileKind | null {
  const name = file.name.toLowerCase()
  if (file.type === 'image/svg+xml' || name.endsWith('.svg')) return 'svg'
  if (/^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/.test(name)) return 'bitmap'
  return null
}

export interface LoadedBitmap {
  pixels: Uint8ClampedArray
  width: number
  height: number
  outWidth: number
  outHeight: number
  url: string
  downscaled: boolean
}

export async function loadBitmap(file: File): Promise<LoadedBitmap> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`파일이 너무 큽니다(${(file.size / 1048576).toFixed(1)}MB). 최대 ${MAX_FILE_BYTES / 1048576}MB까지 지원합니다.`)
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  } catch {
    throw new Error('이미지를 디코딩하지 못했습니다. 손상된 파일이거나 지원하지 않는 형식입니다(PNG·JPG·WEBP 지원).')
  }
  const ow = bmp.width, oh = bmp.height
  if (!ow || !oh) throw new Error('이미지 크기가 0입니다.')
  if (ow > MAX_DECODE_SIDE || oh > MAX_DECODE_SIDE) {
    bmp.close()
    throw new Error(`이미지 해상도가 너무 큽니다(${ow}×${oh}). 한 변 최대 ${MAX_DECODE_SIDE}px까지 지원합니다.`)
  }
  const f = Math.min(1, Math.sqrt(MAX_PROCESS_PIXELS / (ow * oh)))
  const w = Math.max(1, Math.round(ow * f)), h = Math.max(1, Math.round(oh * f))
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const pixels = ctx.getImageData(0, 0, w, h).data
  return { pixels, width: w, height: h, outWidth: ow, outHeight: oh, url: URL.createObjectURL(file), downscaled: f < 1 }
}

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'vector'
}
