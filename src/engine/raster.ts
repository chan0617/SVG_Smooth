// SVG 래스터화(PNG 저장·형태 차이 측정). <img>로 그리므로 SVG 내 스크립트는 실행되지 않는다.

export function svgToBlobUrl(svg: string) {
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('SVG를 이미지로 렌더링하지 못했습니다. 파일 구조를 확인해 주세요.'))
    img.src = url
  })
}

export async function rasterizeSvg(svg: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const url = svgToBlobUrl(svg)
  try {
    const img = await loadImage(url)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(width))
    c.height = Math.max(1, Math.round(height))
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const MAX_PNG_SIDE = 16384
export const MAX_PNG_PIXELS = 120_000_000

/** 투명 PNG 저장(배경 없음) */
export async function svgToPngBlob(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  let w = width * scale, h = height * scale
  const f = Math.min(1, MAX_PNG_SIDE / Math.max(w, h), Math.sqrt(MAX_PNG_PIXELS / (w * h)))
  w *= f; h *= f
  const c = await rasterizeSvg(svg, w, h)
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 인코딩에 실패했습니다. 해상도를 낮춰 보세요.'))), 'image/png'),
  )
}

/** 비교용 해상도: 긴 변 512px */
export function compareSize(width: number, height: number) {
  const f = 512 / Math.max(width, height)
  return { w: Math.max(1, Math.round(width * f)), h: Math.max(1, Math.round(height * f)) }
}

function coverage(c: HTMLCanvasElement) {
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
  const m = new Uint8Array(c.width * c.height)
  for (let i = 0; i < m.length; i++) m[i] = data[i * 4 + 3] > 127 ? 1 : 0
  return m
}

export interface ShapeDiff {
  /** 원본 면적 대비 달라진 픽셀 비율(%) — XOR / 원본 */
  diffPercent: number
  /** 교집합 / 합집합 */
  iou: number
}

function compareMasks(a: Uint8Array, b: Uint8Array): ShapeDiff {
  let x = 0, inter = 0, uni = 0, area = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i]) area++
    if (a[i] !== b[i]) x++
    if (a[i] && b[i]) inter++
    if (a[i] || b[i]) uni++
  }
  return { diffPercent: area ? (x / area) * 100 : 0, iou: uni ? inter / uni : 1 }
}

export async function diffSvgs(original: string, result: string, width: number, height: number): Promise<ShapeDiff> {
  const { w, h } = compareSize(width, height)
  const [a, b] = await Promise.all([rasterizeSvg(original, w, h), rasterizeSvg(result, w, h)])
  return compareMasks(coverage(a), coverage(b))
}

/** 추적 결과 vs 원본 전경 마스크 */
export async function diffAgainstMask(result: string, width: number, height: number, mask: Uint8Array, mw: number, mh: number): Promise<ShapeDiff> {
  const { w, h } = compareSize(width, height)
  const b = coverage(await rasterizeSvg(result, w, h))
  const a = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / w))
      a[y * w + x] = mask[sy * mw + sx]
    }
  }
  return compareMasks(a, b)
}
