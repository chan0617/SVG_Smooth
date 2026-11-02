// 비트맵 → 벡터 추적. Web Worker 안에서 실행된다(DOM 없음).
// 파이프라인: 전경 점수 필드 → (배경 제거) → 업스케일(서브픽셀 보간) → 블러 → 이진화
//            → 작은 조각 제거 / 미세 구멍 메움 → Potrace(WASM) → 좌표 복원 → path d
import { init as potraceInit, potrace } from 'esm-potrace-wasm'
import paper from 'paper/dist/paper-core'
import { mapTraceParams, type ForegroundMode, type TraceOptions, type UiParams } from './params'
import { ensurePaper, countNodes, pathDataOf } from './paperUtil'
import { refinePaths } from './refine'

export interface TraceInput {
  pixels: Uint8ClampedArray
  width: number
  height: number
  /** 원본 이미지 크기(과대 이미지를 줄여서 처리한 경우 좌표를 원본 크기로 되돌린다) */
  outWidth: number
  outHeight: number
  params: UiParams
  options: TraceOptions
}

export interface TraceResult {
  d: string
  width: number
  height: number
  nodes: number
  subpaths: number
  /** 전경 픽셀 평균색(#rrggbb) — '원본' 색상 출력에 사용 */
  color: string
  /** 원본 해상도 전경 마스크(형태 차이 비교 기준) */
  mask: Uint8Array
  maskWidth: number
  maskHeight: number
  usedMode: Exclude<ForegroundMode, 'auto'>
  upscale: number
  removedSpecks: number
  filledPinholes: number
}

let potraceReady: Promise<void> | null = null

function detectMode(px: Uint8ClampedArray, mode: ForegroundMode): 'luminance' | 'alpha' {
  if (mode !== 'auto') return mode
  let transparent = 0
  const total = px.length / 4
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) transparent++
  return transparent / total > 0.01 ? 'alpha' : 'luminance'
}

/** 전경 점수 F(0~255)와 컷오프 C. 전경 ⇔ F > C */
function buildField(input: TraceInput, mode: 'luminance' | 'alpha') {
  const { pixels: px, width: w, height: h, options, params } = input
  const T = Math.max(0, Math.min(255, params.threshold))
  const F = new Float32Array(w * h)
  let cutoff: number
  if (mode === 'alpha') {
    for (let i = 0; i < w * h; i++) {
      const a = px[i * 4 + 3]
      F[i] = options.invert ? 255 - a : a
    }
    cutoff = options.invert ? 255 - T : T
  } else {
    // 투명 영역은 배경색(일반: 흰색, 반전: 검정)과 합성해 항상 배경이 되도록 한다.
    const bgLum = options.invert ? 0 : 255
    for (let i = 0; i < w * h; i++) {
      const o = i * 4
      const a = px[o + 3] / 255
      const lum = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]
      const l = a * lum + (1 - a) * bgLum
      F[i] = options.invert ? l : 255 - l
    }
    cutoff = options.invert ? T : 255 - T
    if (options.removeBackground) removeBorderBackground(input, F)
  }
  return { F, cutoff }
}

/** 테두리에서 연결된 배경색 영역을 찾아 배경으로 확정(F=0) */
function removeBorderBackground(input: TraceInput, F: Float32Array) {
  const { pixels: px, width: w, height: h } = input
  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1)
  const ch = (k: number) =>
    border.map((i) => px[i * 4 + k]).sort((a, b) => a - b)[border.length >> 1]
  const ref = [ch(0), ch(1), ch(2)]
  const tol2 = 48 * 48
  const near = (i: number) => {
    const o = i * 4
    if (px[o + 3] < 128) return true
    const dr = px[o] - ref[0], dg = px[o + 1] - ref[1], db = px[o + 2] - ref[2]
    return dr * dr + dg * dg + db * db < tol2
  }
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  for (const i of border) if (!seen[i] && near(i)) { seen[i] = 1; stack.push(i) }
  while (stack.length) {
    const i = stack.pop()!
    F[i] = 0
    const x = i % w, y = (i / w) | 0
    if (x > 0 && !seen[i - 1] && near(i - 1)) { seen[i - 1] = 1; stack.push(i - 1) }
    if (x < w - 1 && !seen[i + 1] && near(i + 1)) { seen[i + 1] = 1; stack.push(i + 1) }
    if (y > 0 && !seen[i - w] && near(i - w)) { seen[i - w] = 1; stack.push(i - w) }
    if (y < h - 1 && !seen[i + w] && near(i + w)) { seen[i + w] = 1; stack.push(i + w) }
  }
}

function upscaleBilinear(src: Float32Array, w: number, h: number, W: number, H: number) {
  const out = new Float32Array(W * H)
  const kx = w / W, ky = h / H
  for (let Y = 0; Y < H; Y++) {
    let sy = (Y + 0.5) * ky - 0.5
    if (sy < 0) sy = 0
    const y0 = Math.min(h - 1, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0
    for (let X = 0; X < W; X++) {
      let sx = (X + 0.5) * kx - 0.5
      if (sx < 0) sx = 0
      const x0 = Math.min(w - 1, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0
      const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1]
      out[Y * W + X] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    }
  }
  return out
}

/** 3회 박스 블러로 가우시안 근사(분리형) */
function gaussianBlur(data: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.3) return
  const r = Math.max(1, Math.round((Math.sqrt((12 * sigma * sigma) / 3 + 1) - 1) / 2))
  const tmp = new Float32Array(data.length)
  for (let pass = 0; pass < 3; pass++) {
    boxH(data, tmp, w, h, r)
    boxV(tmp, data, w, h, r)
  }
}
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let acc = 0
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
}
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const inv = 1 / (2 * r + 1)
  for (let x = 0; x < w; x++) {
    let acc = 0
    for (let y = -r; y <= r; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * inv
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x]
    }
  }
}

/**
 * 연결 요소 정리. value 값을 가진 픽셀 덩어리 중 maxArea 미만을 반대 값으로 바꾼다.
 * skipBorder=true면 테두리에 닿는 덩어리는 건드리지 않는다(바깥 배경은 구멍이 아님).
 */
function cleanComponents(m: Uint8Array, w: number, h: number, value: 0 | 1, maxArea: number, eight: boolean, skipBorder: boolean) {
  if (maxArea <= 0) return 0
  const seen = new Uint8Array(w * h)
  const comp: number[] = []
  const stack: number[] = []
  let removed = 0
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || m[s] !== value) continue
    comp.length = 0
    stack.push(s)
    seen[s] = 1
    let touches = false
    let tooBig = false
    while (stack.length) {
      const i = stack.pop()!
      if (!tooBig) comp.push(i)
      if (comp.length >= maxArea) tooBig = true
      const x = i % w, y = (i / w) | 0
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          if (!eight && dx && dy) continue
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const j = ny * w + nx
          if (!seen[j] && m[j] === value) { seen[j] = 1; stack.push(j) }
        }
      }
    }
    if (!tooBig && !(skipBorder && touches)) {
      for (const i of comp) m[i] = value ? 0 : 1
      removed++
    }
  }
  return removed
}

const POTRACE_TRANSFORM = /translate\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)\s*scale\(\s*([-\d.eE]+)[ ,]+([-\d.eE]+)\s*\)/

export async function traceBitmap(input: TraceInput): Promise<TraceResult> {
  const { width: w, height: h, pixels: px } = input
  const ep = mapTraceParams(input.params, w, h)
  const mode = detectMode(px, input.options.mode)
  const { F, cutoff } = buildField(input, mode)

  // 원본 해상도 전경 마스크(비교 기준) + 평균 전경색
  const mask = new Uint8Array(w * h)
  let r = 0, g = 0, b = 0, cnt = 0
  for (let i = 0; i < w * h; i++) {
    if (F[i] > cutoff) {
      mask[i] = 1
      r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; cnt++
    }
  }
  if (cnt === 0) {
    throw new Error(
      mode === 'alpha'
        ? '전경으로 판정된 픽셀이 없습니다. 임계값을 낮추거나 판정 방식을 "밝기"로 바꿔 보세요.'
        : '전경으로 판정된 픽셀이 없습니다. 임계값을 조절하거나 "반전"을 켜 보세요.',
    )
  }
  if (cnt === w * h) {
    throw new Error('이미지 전체가 전경으로 판정되었습니다. "반전"이나 "배경 제거"를 켜거나 임계값을 조절해 보세요.')
  }
  const hex = (v: number) => Math.round(v / cnt).toString(16).padStart(2, '0')
  const color = `#${hex(r)}${hex(g)}${hex(b)}`

  // 업스케일 + 블러 + 이진화
  const k = ep.upscale
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k))
  const field = k > 1.001 ? upscaleBilinear(F, w, h, W, H) : F.slice()
  gaussianBlur(field, W, H, ep.blurSigma)
  const bin = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) bin[i] = field[i] > cutoff ? 1 : 0

  const kk = (W / w) * (H / h)
  const removedSpecks = cleanComponents(bin, W, H, 1, Math.round(ep.speckArea * kk), true, false)
  const filledPinholes = cleanComponents(bin, W, H, 0, Math.round(ep.pinholeArea * kk), false, true)

  // Potrace 입력: 전경=검정, 배경=흰색
  const rgba = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const v = bin[i] ? 0 : 255
    const o = i * 4
    rgba[o] = rgba[o + 1] = rgba[o + 2] = v
    rgba[o + 3] = 255
  }
  potraceReady ??= potraceInit()
  await potraceReady
  const svg = await potrace(new ImageData(rgba, W, H), {
    extractcolors: false,
    pathonly: false,
    turdsize: 0, // 조각 제거는 위에서 구멍 보호 규칙과 함께 직접 처리
    turnpolicy: 4,
    alphamax: ep.alphamax,
    opticurve: ep.opticurve ? 1 : 0,
    opttolerance: ep.opttolerance,
  })

  const tm = POTRACE_TRANSFORM.exec(svg)
  const [tx, ty, sx, sy] = tm ? tm.slice(1, 5).map(Number) : [0, 0, 1, 1]
  const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
  if (ds.length === 0) throw new Error('벡터 추적 결과가 비어 있습니다. 임계값과 노이즈 제거 값을 확인해 주세요.')

  ensurePaper()
  const cp = new paper.CompoundPath(ds.join(' '))
  // Potrace 좌표(업스케일 공간, y 뒤집힘) → 원본 이미지 좌표
  const fx = input.outWidth / W, fy = input.outHeight / H
  cp.transform(new paper.Matrix(sx * fx, 0, 0, sy * fy, tx * fx, ty * fy))
  const decimals = input.params.precision >= 70 ? 3 : 2
  let d = pathDataOf(cp, decimals)
  let nodes = countNodes(cp)
  const subpaths = cp.children.length
  cp.remove()

  // 스무스·단순화가 0보다 크면 Potrace 결과를 패스 보정 엔진으로 한 번 더 다듬는다.
  // 모서리를 고정한 채 모서리 사이 구간만 스무딩(비트맵 단계에서 일부 적용했으므로 강도 × 0.6)하고
  // 커브 피팅으로 앵커를 줄인다. 노이즈 제거는 비트맵 단계에서 끝났으므로 0.
  if (input.params.simplify > 0 || input.params.smooth > 0) {
    const refined = refinePaths({
      paths: [{ id: 0, d, scale: 1 }],
      diag: Math.hypot(input.outWidth, input.outHeight),
      params: { ...input.params, smooth: input.params.smooth * 0.6, noise: 0 },
    }).paths[0]
    if (!refined.error && refined.changed && refined.nodesAfter <= nodes) {
      d = refined.d
      nodes = refined.nodesAfter
    }
  }

  return {
    d,
    width: input.outWidth,
    height: input.outHeight,
    nodes,
    subpaths,
    color,
    mask,
    maskWidth: w,
    maskHeight: h,
    usedMode: mode,
    upscale: k,
    removedSpecks,
    filledPinholes,
  }
}
