// UI 정규화 값(0~100, 임계값만 0~255)과 각 엔진 실제 매개변수 사이의 변환을 한 곳에 모은다.
// 원칙: 각 보정 슬라이더가 0이면 그 보정은 "효과 없음"이다.

export interface UiParams {
  smooth: number // 스무스 강도 0~100
  simplify: number // 패스 단순화 0~100
  corner: number // 모서리 유지 0~100
  noise: number // 노이즈 제거 0~100
  precision: number // 곡선 정밀도 0~100
  threshold: number // 이미지 임계값 0~255
}

export const DEFAULT_PARAMS: UiParams = {
  smooth: 35,
  simplify: 20,
  corner: 80,
  noise: 15,
  precision: 85,
  threshold: 128,
}

export type ForegroundMode = 'auto' | 'luminance' | 'alpha'

export interface TraceOptions {
  mode: ForegroundMode
  invert: boolean
  removeBackground: boolean
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  mode: 'auto',
  invert: false,
  removeBackground: false,
}

export interface Preset {
  id: string
  name: string
  description: string
  params: Omit<UiParams, 'threshold'>
}

export const PRESETS: Preset[] = [
  {
    id: 'preserve',
    name: '원본 최대 보존',
    description: '형태 변화 최소, 미세 노이즈만 정리',
    params: { smooth: 8, simplify: 5, corner: 95, noise: 5, precision: 100 },
  },
  {
    id: 'natural',
    name: '자연스러운 스무스',
    description: '기본 균형값, 일러스트 전반',
    params: { smooth: 35, simplify: 20, corner: 80, noise: 15, precision: 85 },
  },
  {
    id: 'strong',
    name: '강력한 선 정리',
    description: '울퉁불퉁한 외곽선과 과도한 노드 정리',
    params: { smooth: 75, simplify: 60, corner: 55, noise: 45, precision: 65 },
  },
  {
    id: 'logo',
    name: '로고 및 타이포그래피',
    description: '직선·모서리 보존, 곡선은 매끈하게',
    params: { smooth: 40, simplify: 35, corner: 92, noise: 20, precision: 90 },
  },
  {
    id: 'street',
    name: '날카로운 스트릿 그래픽',
    description: '뾰족한 끝과 붓 터치의 날을 살림',
    params: { smooth: 25, simplify: 25, corner: 100, noise: 25, precision: 95 },
  },
  {
    id: 'sticker',
    name: '스티커 인쇄용',
    description: '칼선용으로 부드럽고 노드가 적은 외곽',
    params: { smooth: 65, simplify: 50, corner: 60, noise: 60, precision: 75 },
  },
]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/* ------------------------------------------------------------------ */
/* SVG 패스 보정 엔진(Paper.js 기반, refine.ts) 매개변수                 */
/* ------------------------------------------------------------------ */

export interface RefineEngineParams {
  /** 재샘플링 간격(문서 단위). 정밀도가 높을수록 촘촘하다. */
  sampleStep: number
  /** 가우시안 스무딩 σ(문서 단위, 호 길이 기준). 0이면 스무딩 없음. */
  smoothSigma: number
  /** 커브 피팅 허용 오차(문서 단위, 최대 편차). Paper.js fit()에는 제곱해서 넘긴다. */
  fitTolerance: number
  /** 이 각도(도)보다 크게 꺾이면 모서리로 고정. 180이면 모서리 고정 없음. */
  cornerAngle: number
  /** 모서리 판정에 쓰는 앞뒤 관찰 거리(문서 단위). 계단 노이즈보다 넓어야 한다. */
  cornerWindow: number
  /** 이 면적(문서 단위²)보다 작은 닫힌 조각은 노이즈로 제거. 구멍은 1/4 기준 적용. */
  noiseArea: number
  /** path d 출력 소수 자릿수 */
  decimals: number
  /** 스무스·단순화가 모두 0이면 기하 형태를 건드리지 않는다. */
  geometryEnabled: boolean
}

/**
 * UI 값 → 패스 보정 엔진 값.
 * 모든 거리 값은 문서 대각선 길이(diag, viewBox 단위)에 비례시켜
 * 작은 아이콘과 큰 포스터에서 슬라이더 체감이 같도록 한다.
 *
 * - 곡선 정밀도 p: 샘플 간격 diag×(0.4% → 0.05%), 최소 피팅 오차 diag×(0.12% → 0.015%)
 * - 스무스 s: σ = diag×0.9%×(s/100)^1.3 — 0이면 0. 모서리 고정 구간 사이에서만 적용되므로
 *   스무스를 올려도 모서리로 판정된 점은 둥글어지지 않는다.
 * - 단순화 q: 피팅 오차 = 최소오차 + diag×0.6%×(q/100)^1.6 — 오차가 클수록 앵커가 줄어든다.
 * - 모서리 유지 c: 판정 각도 180° → 25° (c=0이면 모서리 없음, c=100이면 25° 이상 꺾임은 모두 보존)
 * - 노이즈 n: 제거 면적 = (diag×1.2%×n/100)² — 0이면 아무것도 제거하지 않음
 */
export function mapRefineParams(ui: UiParams, diag: number): RefineEngineParams {
  const p = clamp(ui.precision, 0, 100) / 100
  const s = clamp(ui.smooth, 0, 100) / 100
  const q = clamp(ui.simplify, 0, 100) / 100
  const c = clamp(ui.corner, 0, 100) / 100
  const n = clamp(ui.noise, 0, 100) / 100

  const sampleStep = diag * lerp(0.004, 0.0005, p)
  const minTol = diag * lerp(0.0012, 0.00015, p)
  const smoothSigma = s === 0 ? 0 : diag * 0.009 * Math.pow(s, 1.3)
  const fitTolerance = minTol + diag * 0.006 * Math.pow(q, 1.6)
  const cornerAngle = c === 0 ? 180 : lerp(170, 25, c)
  const cornerWindow = Math.max(sampleStep * 3, smoothSigma * 1.5, fitTolerance * 2)
  const noiseLen = diag * 0.012 * n
  return {
    sampleStep,
    smoothSigma,
    fitTolerance,
    cornerAngle,
    cornerWindow,
    noiseArea: noiseLen * noiseLen,
    decimals: p >= 0.7 ? 3 : 2,
    geometryEnabled: s > 0 || q > 0,
  }
}

/* ------------------------------------------------------------------ */
/* 비트맵 추적 엔진(Potrace WASM, trace.ts) 매개변수                     */
/* ------------------------------------------------------------------ */

export interface TraceEngineParams {
  /** 추적 전 업스케일 배율. 계단형 경계를 서브픽셀 보간으로 풀기 위함. */
  upscale: number
  /** 업스케일 후 해상도 기준 가우시안 σ(px). 0이면 블러 없음. */
  blurSigma: number
  /** 원본 픽셀 기준: 이 면적 미만 전경 조각 제거 */
  speckArea: number
  /** 원본 픽셀 기준: 이 면적 미만 구멍만 메움(구멍 보호를 위해 speck의 1/5) */
  pinholeArea: number
  /** Potrace alphamax: 0=다각형(모두 모서리), 1.3334 이상=모서리 없음 */
  alphamax: number
  /** Potrace opticurve 사용 여부와 허용 오차(업스케일 공간 px — 원본 px 기준 값 × upscale) */
  opticurve: boolean
  opttolerance: number
  /** 0~255 밝기/알파 임계값 */
  threshold: number
}

/**
 * UI 값 → 추적 엔진 값.
 * - 곡선 정밀도 p: 업스케일 1× → 4×, 단 작업 픽셀 수 ≤ 8MP, 긴 변 ≤ 6000px로 제한
 * - 스무스 s: Potrace alphamax = 1.3334×√s, 그러나 모서리 유지 c가
 *   상한을 1.3334 → 0.75로 낮춘다(스무스를 올려도 모서리가 사라지지 않도록 c가 우선).
 *   블러 σ(원본 px) = 1.6×s×(1−0.75c): 모서리 유지가 높을수록 블러를 줄여 뾰족한 끝을 보호.
 * - 단순화 q: q=0이면 opticurve 끔(Potrace 커브 결합 안 함). q>0이면 opttolerance 0.05 → 1.2(원본 px).
 *   Potrace는 업스케일된 비트맵을 보므로 실제 전달값은 × upscale.
 * - 노이즈 n: 제거 면적 = n²×max(64, 이미지 면적×0.06%) px², 구멍은 그 1/5 미만만 메움
 */
export function mapTraceParams(ui: UiParams, width: number, height: number): TraceEngineParams {
  const p = clamp(ui.precision, 0, 100) / 100
  const s = clamp(ui.smooth, 0, 100) / 100
  const q = clamp(ui.simplify, 0, 100) / 100
  const c = clamp(ui.corner, 0, 100) / 100
  const n = clamp(ui.noise, 0, 100) / 100

  const desired = lerp(1, 4, p)
  const byPixels = Math.sqrt(8_000_000 / Math.max(1, width * height))
  const bySide = 6000 / Math.max(width, height)
  const upscale = Math.max(1, Math.min(desired, byPixels, bySide))

  const alphaCap = lerp(1.3334, 0.75, c)
  const alphamax = Math.min(1.3334 * Math.sqrt(s), alphaCap)
  const blurOrig = 1.6 * s * (1 - 0.75 * c)

  const speckArea = n === 0 ? 0 : n * n * Math.max(64, width * height * 0.0006)
  return {
    upscale,
    blurSigma: blurOrig * upscale,
    speckArea,
    pinholeArea: speckArea / 5,
    alphamax,
    opticurve: q > 0,
    opttolerance: lerp(0.05, 1.2, q) * upscale,
    threshold: clamp(Math.round(ui.threshold), 0, 255),
  }
}
