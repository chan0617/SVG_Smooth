// UI와 테스트 하네스가 함께 쓰는 처리 파이프라인
import type { EngineClient } from './client'
import type { LoadedBitmap } from './image'
import type { TraceOptions, UiParams } from './params'
import { diffAgainstMask, diffSvgs, type ShapeDiff } from './raster'
import { buildSvg, buildTracedSvg, serializeOriginal, type ColorMode, type ParsedSvg } from './svgDoc'

export interface ProcessResult {
  kind: 'trace' | 'refine'
  /** 화면 표시용(원본 색상) 결과 SVG */
  svg: string
  /** 색상 모드별 SVG 생성 */
  render: (color: ColorMode) => string
  width: number
  height: number
  viewBox: string
  nodesBefore: number | null
  nodesAfter: number
  subpathsBefore: number | null
  subpathsAfter: number
  diff: ShapeDiff | null
  meanDeviation: number | null
  maxDeviation: number | null
  messages: string[]
  /** 오버레이 표시용: 결과 path d 목록(루트 좌표계 변환 행렬 포함) */
  overlay: { d: string; matrix: DOMMatrix | null }[]
  elapsedMs: number
}

export async function processBitmap(client: EngineClient, bmp: LoadedBitmap, params: UiParams, options: TraceOptions): Promise<ProcessResult | null> {
  const t0 = performance.now()
  const r = await client.trace({ pixels: bmp.pixels, width: bmp.width, height: bmp.height, outWidth: bmp.outWidth, outHeight: bmp.outHeight, params, options })
  if (!r) return null
  const render = (color: ColorMode) =>
    buildTracedSvg(r.d, r.width, r.height, color === 'original' ? r.color : color === 'black' ? '#000000' : '#ffffff')
  const svg = render('original')
  const diff = await diffAgainstMask(svg, r.width, r.height, r.mask, r.maskWidth, r.maskHeight)
  const messages: string[] = []
  messages.push(`판정 방식: ${r.usedMode === 'alpha' ? '투명도(알파)' : '밝기'} · 추적 배율 ${r.upscale.toFixed(2)}×`)
  if (bmp.downscaled) messages.push(`이미지가 커서 ${bmp.width}×${bmp.height}로 줄여 처리했습니다(결과 좌표는 원본 ${bmp.outWidth}×${bmp.outHeight} 기준).`)
  if (r.removedSpecks) messages.push(`작은 노이즈 조각 ${r.removedSpecks}개 제거`)
  if (r.filledPinholes) messages.push(`미세 구멍 ${r.filledPinholes}개 메움(더 큰 구멍은 보존)`)
  return {
    kind: 'trace',
    svg,
    render,
    width: r.width,
    height: r.height,
    viewBox: `0 0 ${r.width} ${r.height}`,
    nodesBefore: null,
    nodesAfter: r.nodes,
    subpathsBefore: null,
    subpathsAfter: r.subpaths,
    diff,
    meanDeviation: null,
    maxDeviation: null,
    messages,
    overlay: [{ d: r.d, matrix: null }],
    elapsedMs: performance.now() - t0,
  }
}

export async function processSvg(client: EngineClient, parsed: ParsedSvg, params: UiParams, matrices: DOMMatrix[]): Promise<ProcessResult | null> {
  const t0 = performance.now()
  const r = await client.refine({
    paths: parsed.ds.map((d, i) => ({ id: i, d, scale: parsed.scales[i] })),
    diag: parsed.diag,
    params,
  })
  if (!r) return null
  const replacements = new Map<number, string>()
  let nb = 0, na = 0, sb = 0, sa = 0, removed = 0, fallbacks = 0, errors = 0
  for (const p of r.paths) {
    nb += p.nodesBefore
    na += p.nodesAfter
    sb += p.subpathsBefore
    sa += p.subpathsAfter
    removed += p.removedNoise
    fallbacks += p.fallbacks
    if (p.error) errors++
    if (p.changed) replacements.set(parsed.editable[p.id], p.d)
  }
  const render = (color: ColorMode) => buildSvg(parsed, replacements, color)
  const svg = render('original')
  const vb = parsed.viewBox
  const diff = await diffSvgs(serializeOriginal(parsed), svg, parsed.width, parsed.height)
  const messages: string[] = [...parsed.report.notes]
  if (removed) messages.push(`노이즈 조각 ${removed}개 제거(구멍은 더 엄격한 기준으로 보호)`)
  if (r.corners) messages.push(`모서리 ${r.corners}개 고정`)
  if (fallbacks) messages.push(`형태 변화가 커서 ${fallbacks}개 서브패스는 원본을 유지했습니다(작은 구멍·가는 획 보호).`)
  if (errors) messages.push(`${errors}개 path는 해석할 수 없어 원본 그대로 보존했습니다.`)
  const byIdx = new Map(r.paths.map((p) => [p.id, p.d]))
  return {
    kind: 'refine',
    svg,
    render,
    width: parsed.width,
    height: parsed.height,
    viewBox: `${vb.x} ${vb.y} ${vb.w} ${vb.h}`,
    nodesBefore: nb,
    nodesAfter: na,
    subpathsBefore: sb,
    subpathsAfter: sa,
    diff,
    meanDeviation: r.meanDeviation,
    maxDeviation: r.maxDeviation,
    messages,
    overlay: parsed.ds.map((d, i) => ({ d: byIdx.get(i) ?? d, matrix: matrices[i] ?? null })),
    elapsedMs: performance.now() - t0,
  }
}
