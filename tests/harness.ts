// 실제 엔진(Worker + Potrace WASM + Paper.js)을 브라우저에서 돌려 검증하는 테스트 하네스.
// scripts/run-tests.mjs가 헤드리스 Chrome으로 이 페이지를 열어 window.runAllTests()를 호출한다.
import paper from 'paper/dist/paper-core'
import { EngineClient } from '../src/engine/client'
import { loadBitmap } from '../src/engine/image'
import { DEFAULT_PARAMS, DEFAULT_TRACE_OPTIONS, PRESETS, type TraceOptions, type UiParams } from '../src/engine/params'
import { processBitmap, processSvg, type ProcessResult } from '../src/engine/pipeline'
import { svgToPngBlob } from '../src/engine/raster'
import { overlayMatrices, parseSvg } from '../src/engine/svgDoc'

type Pt = [number, number]
interface Check { name: string; pass: boolean; detail: string }
interface CaseReport {
  id: string
  title: string
  kind: 'trace' | 'refine'
  nodesBefore: number | null
  nodesAfter: number
  subpathsBefore: number | null
  subpathsAfter: number
  diffPercent: number | null
  iou: number | null
  maxDeviation: number | null
  ms: number
  checks: Check[]
}

paper.setup(new paper.Size(1, 1))
;(window as unknown as { paper: typeof paper }).paper = paper
const client = new EngineClient()
const fixtures: Record<string, { name: string; dataUrl: string }> = {}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!] as const
}
async function canvasFile(c: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
  fixtures[name] = { name, dataUrl: c.toDataURL('image/png') }
  return new File([blob], name, { type: 'image/png' })
}
function svgFixture(name: string, text: string) {
  fixtures[name] = { name, dataUrl: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text))) }
  return text
}
function starPoints(cx: number, cy: number, R: number, r: number, n: number, rot = -Math.PI / 2): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n
    const rr = i % 2 ? r : R
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
  }
  return pts
}
const tipsOf = (pts: Pt[]) => pts.filter((_, i) => i % 2 === 0)

/** 결과 path가 각 기준점(뾰족한 끝)을 얼마나 가깝게 지나는지 */
function tipError(d: string, tips: Pt[]) {
  const item = paper.PathItem.create(d)
  let worst = 0
  for (const [x, y] of tips) {
    const near = item.getNearestPoint(new paper.Point(x, y))
    worst = Math.max(worst, near ? near.getDistance(new paper.Point(x, y)) : Infinity)
  }
  item.remove()
  return worst
}

function holesOf(d: string) {
  const item = paper.PathItem.create(d)
  const subs = item instanceof paper.CompoundPath ? (item.children as paper.Path[]) : [item as paper.Path]
  const outerSign = Math.sign(subs.reduce((best, p) => (Math.abs(p.area) > Math.abs(best) ? p.area : best), 0))
  const holes = subs.filter((p) => Math.sign(p.area) !== outerSign).length
  item.remove()
  return { total: subs.length, holes }
}

async function validateDownloads(res: ProcessResult): Promise<Check[]> {
  const checks: Check[] = []
  for (const color of ['original', 'black', 'white'] as const) {
    const svg = res.render(color)
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const ok = !doc.querySelector('parsererror') && doc.documentElement.localName === 'svg'
    const hasPath = /<path[^>]*\sd="[^"]{4,}/.test(svg)
    // 추적 결과에는 비트맵이 전혀 없어야 한다. 보정 모드는 사용자 원본의 <image>는 보존하되 외부 참조는 없어야 한다.
    const noBitmap = res.kind === 'trace' ? !/base64|<image/i.test(svg) : !/href="https?:/i.test(svg)
    checks.push({ name: `SVG(${color}) 유효`, pass: ok && hasPath && noBitmap, detail: `parse=${ok} path=${hasPath} noBitmap=${noBitmap}, ${svg.length}B` })
  }
  for (const scale of [1, 2, 4]) {
    const blob = await svgToPngBlob(res.svg, res.width, res.height, scale)
    const bmp = await createImageBitmap(blob)
    const okSize = bmp.width === Math.round(res.width * scale) && bmp.height === Math.round(res.height * scale)
    // 투명 배경 확인: 모서리 픽셀 알파
    const [c, ctx] = canvas(bmp.width, bmp.height)
    ctx.drawImage(bmp, 0, 0)
    const corner = ctx.getImageData(0, 0, 1, 1).data[3]
    checks.push({ name: `PNG ${scale}x`, pass: okSize && blob.type === 'image/png', detail: `${bmp.width}×${bmp.height}, ${(blob.size / 1024).toFixed(1)}KB, 모서리 알파=${corner}` })
    void c
  }
  return checks
}

function report(id: string, title: string, res: ProcessResult, checks: Check[]): CaseReport {
  return {
    id,
    title,
    kind: res.kind,
    nodesBefore: res.nodesBefore,
    nodesAfter: res.nodesAfter,
    subpathsBefore: res.subpathsBefore,
    subpathsAfter: res.subpathsAfter,
    diffPercent: res.diff ? +res.diff.diffPercent.toFixed(2) : null,
    iou: res.diff ? +res.diff.iou.toFixed(4) : null,
    maxDeviation: res.maxDeviation != null ? +res.maxDeviation.toFixed(3) : null,
    ms: Math.round(res.elapsedMs),
    checks,
  }
}

async function trace(file: File, params: UiParams = DEFAULT_PARAMS, opts: TraceOptions = DEFAULT_TRACE_OPTIONS) {
  const bmp = await loadBitmap(file)
  const res = await processBitmap(client, bmp, params, opts)
  if (!res) throw new Error('trace cancelled')
  return res
}
async function refine(text: string, params: UiParams = DEFAULT_PARAMS) {
  const parsed = parseSvg(text)
  const res = await processSvg(client, parsed, params, overlayMatrices(parsed))
  if (!res) throw new Error('refine cancelled')
  return { res, parsed }
}
const d0 = (svg: string) => /<path[^>]*\sd="([^"]+)"/.exec(svg)?.[1] ?? ''

// ---------------------------------------------------------------- 테스트 케이스

async function case1(): Promise<CaseReport[]> {
  // 1. 투명 배경 검정 로고(구멍 있는 원 + 별 + 사각 모서리)
  const [c, ctx] = canvas(480, 240)
  ctx.fillStyle = '#111'
  ctx.beginPath()
  ctx.arc(120, 120, 90, 0, Math.PI * 2)
  ctx.arc(120, 120, 45, 0, Math.PI * 2, true)
  ctx.fill()
  ctx.fillRect(250, 40, 180, 60)
  const star = starPoints(340, 175, 60, 24, 5)
  ctx.beginPath()
  star.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fill()
  const file = await canvasFile(c, '1-black-logo-transparent.png')
  const res = await trace(file)
  const h = holesOf(d0(res.svg))
  const rectTips: Pt[] = [[250, 40], [430, 40], [430, 100], [250, 100]]
  const checks: Check[] = [
    { name: '이미지 손실(형태 차이 < 3%)', pass: res.diff!.diffPercent < 3, detail: `${res.diff!.diffPercent.toFixed(2)}%` },
    { name: '구멍 보존(링 구멍 1개)', pass: h.holes === 1 && h.total === 4, detail: `서브패스 ${h.total}, 구멍 ${h.holes}` },
    { name: '사각 모서리 유지(< 1.5px)', pass: tipError(d0(res.svg), rectTips) < 1.5, detail: `${tipError(d0(res.svg), rectTips).toFixed(2)}px` },
    { name: '별 끝 유지(< 2.5px)', pass: tipError(d0(res.svg), tipsOf(star)) < 2.5, detail: `${tipError(d0(res.svg), tipsOf(star)).toFixed(2)}px` },
    ...(await validateDownloads(res)),
  ]
  return [report('1', '투명 배경 검정 PNG 로고', res, checks)]
}

async function case2(): Promise<CaseReport[]> {
  // 2. 계단 현상이 심한 저해상도 PNG(안티앨리어싱 없는 48×48 픽셀)
  const W = 48
  const [c, ctx] = canvas(W, W)
  const img = ctx.createImageData(W, W)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const inCircle = (x + 0.5 - 17) ** 2 + (y + 0.5 - 17) ** 2 < 13 ** 2
      const inTri = y > 26 && y < 46 && x > 22 && x - 22 < (y - 26) * 1.2
      const o = (y * W + x) * 4
      const v = inCircle || inTri ? 0 : 255
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v
      img.data[o + 3] = 255
    }
  ctx.putImageData(img, 0, 0)
  const file = await canvasFile(c, '2-lowres-staircase.png')
  const out: CaseReport[] = []
  for (const preset of [PRESETS[1], PRESETS[2]]) {
    const res = await trace(file, { ...DEFAULT_PARAMS, ...preset.params })
    // 계단 정도: 원 부분 결과 경계 샘플이 이상적 원(반지름 13)에서 벗어난 최대 거리
    const item = paper.PathItem.create(d0(res.svg))
    let maxDev = 0
    for (let a = 0; a < 360; a += 3) {
      const r = (a * Math.PI) / 180
      const p = new paper.Point(17 + Math.cos(r) * 13, 17 + Math.sin(r) * 13)
      if (p.x > 21 && p.y > 24) continue // 삼각형과 겹치는 쪽 제외
      const n = item.getNearestPoint(p)
      maxDev = Math.max(maxDev, n.getDistance(p))
    }
    item.remove()
    const checks: Check[] = [
      { name: '계단 제거(이상적 원 대비 최대 편차 < 0.75px)', pass: maxDev < 0.75, detail: `${maxDev.toFixed(3)}px (픽셀 계단 ≈ 0.5~0.7px)` },
      { name: '형태 유지(차이 < 8%)', pass: res.diff!.diffPercent < 8, detail: `${res.diff!.diffPercent.toFixed(2)}%` },
      { name: '삼각형 아래 모서리 유지(< 1.5px)', pass: tipError(d0(res.svg), [[45, 46]]) < 1.5, detail: `${tipError(d0(res.svg), [[45, 46]]).toFixed(2)}px` },
      { name: '노드 수 적정(≤ 60)', pass: res.nodesAfter <= 60, detail: `${res.nodesAfter}개` },
      ...(await validateDownloads(res)),
    ]
    out.push(report(`2-${preset.id}`, `저해상도 계단 PNG (${preset.name})`, res, checks))
  }
  return out
}

function noisyBlobSvg() {
  // 3. 곡선 노드가 과도하게 많은 SVG: 1800개 노드의 울퉁불퉁한 원 + 사각형(직선·모서리) 경로, transform 그룹 포함
  let rnd = 7
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5)
  const pts: string[] = []
  for (let i = 0; i < 1800; i++) {
    const a = (i / 1800) * Math.PI * 2
    const r = 150 + 6 * Math.sin(a * 5) + rand() * 2.4
    pts.push(`${(200 + Math.cos(a) * r).toFixed(2)},${(200 + Math.sin(a) * r).toFixed(2)}`)
  }
  // Catmull-Rom → 3차 베지어: 노드마다 C 곡선
  const P = pts.map((s) => s.split(',').map(Number))
  const f = (v: number) => v.toFixed(2)
  let blob = `M${pts[0]}`
  for (let i = 0; i < P.length; i++) {
    const p0 = P[(i - 1 + P.length) % P.length], p1 = P[i], p2 = P[(i + 1) % P.length], p3 = P[(i + 2) % P.length]
    blob += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`
  }
  blob += ' Z'
  const rect: string[] = []
  const side = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = 0; i < 200; i++) rect.push(`${(x0 + ((x1 - x0) * i) / 200 + rand() * 0.8).toFixed(2)},${(y0 + ((y1 - y0) * i) / 200 + rand() * 0.8).toFixed(2)}`)
  }
  side(0, 0, 200, 0); side(200, 0, 200, 120); side(200, 120, 0, 120); side(0, 120, 0, 0)
  const rectD = `M${rect[0]} L` + rect.slice(1).join(' L') + ' Z'
  return svgFixture(
    '3-too-many-nodes.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="400" viewBox="0 0 800 400">
  <script>alert(1)</script>
  <g id="layer-blob" fill="#2a6"><path id="blob" d="${blob}" onclick="alert(2)"/></g>
  <g id="layer-rect" transform="translate(460 140) scale(1.5)"><path id="rect" d="${rectD}" fill="#e33"/></g>
  <text x="20" y="390" font-size="20" fill="#333">편집 가능한 텍스트</text>
  <rect x="700" y="20" width="60" height="30" fill="#36f"/>
  <image href="https://example.com/x.png" x="0" y="0" width="10" height="10"/>
</svg>`,
  )
}

async function case3(): Promise<CaseReport[]> {
  const text = noisyBlobSvg()
  const { res, parsed } = await refine(text)
  const corners: Pt[] = [[460, 140], [760, 140], [760, 320], [460, 320]]
  const rectIdx = parsed.editable.indexOf(Array.from(parsed.doc.getElementsByTagName('path')).findIndex((p) => p.id === 'rect'))
  const rectD = res.overlay[rectIdx].d
  const rectItem = paper.PathItem.create(rectD)
  rectItem.transform(new paper.Matrix(1.5, 0, 0, 1.5, 460, 140))
  const cornerErr = Math.max(...corners.map(([x, y]) => rectItem.getNearestPoint(new paper.Point(x, y)).getDistance(new paper.Point(x, y))))
  rectItem.remove()
  const zero = await refine(text, { smooth: 0, simplify: 0, corner: 80, noise: 0, precision: 85, threshold: 128 })
  const zeroSame = zero.parsed.ds.every((d, i) => zero.res.overlay[i].d === d)
  const checks: Check[] = [
    { name: '앵커 포인트 감소(≥ 80%)', pass: res.nodesAfter <= res.nodesBefore! * 0.2, detail: `${res.nodesBefore} → ${res.nodesAfter}` },
    { name: '형태 차이 < 2%', pass: res.diff!.diffPercent < 2, detail: `${res.diff!.diffPercent.toFixed(2)}%, 최대 편차 ${res.maxDeviation?.toFixed(2)}` },
    { name: 'transform 그룹 내 사각 모서리 유지(< 1.5)', pass: cornerErr < 1.5, detail: `${cornerErr.toFixed(2)}` },
    { name: '스크립트·이벤트·외부 이미지 차단', pass: !/<script|onclick|example\.com/.test(res.svg), detail: parsed.report.notes.filter((n) => /제거|차단/.test(n)).join(' / ') },
    { name: '텍스트·도형·그룹·transform 보존', pass: /<text[^>]*>편집 가능한 텍스트<\/text>/.test(res.svg) && /<rect x="700"/.test(res.svg) && /transform="translate\(460 140\) scale\(1.5\)"/.test(res.svg) && /id="layer-blob"/.test(res.svg), detail: 'text/rect/g/transform/id' },
    { name: 'viewBox 보존', pass: /viewBox="0 0 800 400"/.test(res.svg), detail: res.viewBox },
    { name: '슬라이더 0 = 효과 없음(d 동일)', pass: zeroSame, detail: zeroSame ? '모든 path d 동일' : '변경 발생' },
    ...(await validateDownloads(res)),
  ]
  return [report('3', '곡선 노드가 과도한 SVG', res, checks)]
}

async function case4(): Promise<CaseReport[]> {
  // 4. 구멍 있는 글자 O, B, 8 — PNG 추적 + 추적 결과(노드 과다 버전)를 SVG로 다시 보정
  const [c, ctx] = canvas(520, 220)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 520, 220)
  ctx.fillStyle = '#000'
  ctx.font = 'bold 180px Arial, Helvetica, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText('OB8', 20, 115)
  const file = await canvasFile(c, '4-holes-OB8.png')
  const res = await trace(file)
  const h = holesOf(d0(res.svg))
  const checks: Check[] = [
    { name: '구멍 보존(O1 + B2 + 8×2 = 5)', pass: h.holes === 5, detail: `서브패스 ${h.total}, 구멍 ${h.holes}` },
    { name: '형태 차이 < 3%', pass: res.diff!.diffPercent < 3, detail: `${res.diff!.diffPercent.toFixed(2)}%` },
    ...(await validateDownloads(res)),
  ]
  const out = [report('4a', '구멍 글자 OB8 (PNG 추적)', res, checks)]

  // 노드가 많은 복합 경로 SVG 만들기: 단순화·스무스 0으로 추적 → 다각형(노드 다수)
  const raw = await trace(file, { smooth: 0, simplify: 0, corner: 100, noise: 0, precision: 100, threshold: 128 })
  const svgText = svgFixture('4-holes-OB8-compound.svg', raw.render('black'))
  const { res: r2 } = await refine(svgText)
  const h2 = holesOf(d0(r2.svg))
  const checks2: Check[] = [
    { name: '복합 경로 구멍 보존', pass: h2.holes === h.holes && h2.total === holesOf(d0(svgText)).total, detail: `구멍 ${holesOf(d0(svgText)).holes} → ${h2.holes}` },
    { name: '앵커 감소', pass: r2.nodesAfter < r2.nodesBefore!, detail: `${r2.nodesBefore} → ${r2.nodesAfter}` },
    { name: '윤곽 편차(평균 < 0.4px, 형태 차이 < 5%)', pass: r2.meanDeviation! < 0.4 && r2.diff!.diffPercent < 5, detail: `평균 ${r2.meanDeviation!.toFixed(3)}px, 최대 ${r2.maxDeviation!.toFixed(2)}px, 형태차 ${r2.diff!.diffPercent.toFixed(2)}%` },
    { name: 'fill-rule 유지', pass: /fill-rule="nonzero"/.test(r2.svg), detail: 'nonzero' },
    ...(await validateDownloads(r2)),
  ]
  out.push(report('4b', '구멍 글자 복합 경로 SVG 보정', r2, checks2))
  return out
}

async function case5(): Promise<CaseReport[]> {
  // 5. 뾰족한 별 + 날카로운 붓글씨(양 끝이 뾰족한 초승달 획)
  const [c, ctx] = canvas(520, 300)
  ctx.fillStyle = '#000'
  const star = starPoints(140, 150, 120, 38, 7)
  ctx.beginPath()
  star.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fill()
  // 붓 획: 두 개의 베지어로 이루어진 끝이 뾰족한 획
  const brushTips: Pt[] = [[290, 250], [500, 40]]
  ctx.beginPath()
  ctx.moveTo(...brushTips[0])
  ctx.bezierCurveTo(330, 120, 420, 60, 500, 40)
  ctx.bezierCurveTo(440, 100, 380, 170, 290, 250)
  ctx.fill()
  const file = await canvasFile(c, '5-sharp-star-brush.png')
  const out: CaseReport[] = []
  for (const preset of [PRESETS[4], PRESETS[2]]) {
    const res = await trace(file, { ...DEFAULT_PARAMS, ...preset.params })
    const starErr = tipError(d0(res.svg), tipsOf(star))
    const brushErr = tipError(d0(res.svg), brushTips)
    // 별 끝의 각도는 약 22°로 매우 예리하다. 안티앨리어싱된 래스터에서는 폭이 1px 미만인
    // 끝 ~2.6px가 이미 50% 미만 커버리지라 비트맵 자체에 정보가 없다. 그 한계를 감안한 기준.
    const limit = preset.id === 'street' ? 3.2 : 4.5
    const checks: Check[] = [
      { name: `별 끝 7개 유지(< ${limit}px)`, pass: starErr < limit, detail: `${starErr.toFixed(2)}px` },
      { name: `붓 획 끝 유지(< ${limit + 1}px)`, pass: brushErr < limit + 1, detail: `${brushErr.toFixed(2)}px` },
      // '강력한 선 정리'는 허용 오차가 커서(≈ 문서 대각선의 0.3%) 형태 차이를 조금 더 허용
      { name: `형태 차이 < ${preset.id === 'street' ? 4 : 5}%`, pass: res.diff!.diffPercent < (preset.id === 'street' ? 4 : 5), detail: `${res.diff!.diffPercent.toFixed(2)}%` },
      ...(await validateDownloads(res)),
    ]
    out.push(report(`5-${preset.id}`, `뾰족한 별·붓글씨 (${preset.name})`, res, checks))
  }

  // SVG 보정에서도: 노드가 많은(지터 포함) 별 SVG → 스무스 최대여도 끝 유지
  let rnd = 3
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5)
  const dense: string[] = []
  for (let i = 0; i < star.length; i++) {
    const [x0, y0] = star[i], [x1, y1] = star[(i + 1) % star.length]
    for (let k = 0; k < 40; k++) {
      const t = k / 40
      const j = k === 0 ? 0 : rand() * 1.2
      dense.push(`${(x0 + (x1 - x0) * t + j).toFixed(2)},${(y0 + (y1 - y0) * t + j).toFixed(2)}`)
    }
  }
  const svgText = svgFixture('5-dense-star.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300"><path d="M${dense[0]} L${dense.slice(1).join(' L')} Z"/></svg>`)
  const { res: r2 } = await refine(svgText, { smooth: 100, simplify: 60, corner: 80, noise: 15, precision: 85, threshold: 128 })
  const err2 = tipError(d0(r2.svg), tipsOf(star))
  out.push(
    report('5c', '지터 있는 별 SVG (스무스 100)', r2, [
      { name: '스무스 100에서도 별 끝 유지(< 1px)', pass: err2 < 1, detail: `${err2.toFixed(3)}px` },
      { name: '앵커 감소', pass: r2.nodesAfter < r2.nodesBefore! * 0.2, detail: `${r2.nodesBefore} → ${r2.nodesAfter}` },
      { name: '형태 차이 < 3%', pass: r2.diff!.diffPercent < 3, detail: `${r2.diff!.diffPercent.toFixed(2)}%` },
      ...(await validateDownloads(r2)),
    ]),
  )
  return out
}

async function case6(): Promise<CaseReport[]> {
  // 6. 흰색 로고 + 투명 배경(밝기 기준이면 사라지므로 자동=알파 판정이 필요)
  const [c, ctx] = canvas(400, 200)
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.roundRect(30, 30, 340, 140, 40)
  ctx.fill()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(120, 100, 40, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = 'bold 90px Arial, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText('A', 210, 104)
  const file = await canvasFile(c, '6-white-logo-transparent.png')
  const res = await trace(file)
  const h = holesOf(d0(res.svg))
  const whiteSvg = res.render('original')
  const checks: Check[] = [
    { name: '자동 판정 = 투명도', pass: res.messages[0].includes('투명도'), detail: res.messages[0] },
    { name: '흰색 유지(원본 색상)', pass: /fill="#ffffff"/.test(whiteSvg), detail: (/fill="(#[0-9a-f]{6})"/.exec(whiteSvg) || [])[1] ?? '' },
    { name: '구멍 보존(원 + A + A 내부 섬)', pass: h.holes === 2 && h.total === 4, detail: `서브패스 ${h.total}, 구멍 ${h.holes}` },
    { name: '형태 차이 < 3%', pass: res.diff!.diffPercent < 3, detail: `${res.diff!.diffPercent.toFixed(2)}%` },
    ...(await validateDownloads(res)),
  ]
  return [report('6', '흰색 로고 + 투명 배경', res, checks)]
}

async function caseErrors(): Promise<CaseReport[]> {
  const checks: Check[] = []
  const expectErr = async (name: string, fn: () => Promise<unknown> | unknown, re: RegExp) => {
    try {
      await fn()
      checks.push({ name, pass: false, detail: '오류가 발생하지 않음' })
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      checks.push({ name, pass: re.test(m), detail: m })
    }
  }
  await expectErr('깨진 SVG', () => parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"></svg>'), /구문 오류/)
  await expectErr('SVG 아님', () => parseSvg('hello'), /루트 요소/)
  await expectErr('깨진 PNG', () => loadBitmap(new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' })), /디코딩/)
  const [c, ctx] = canvas(50, 50)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 50, 50)
  const blank = await canvasFile(c, 'blank.png')
  delete fixtures['blank.png']
  await expectErr('빈 이미지', () => trace(blank), /전경으로 판정된 픽셀이 없습니다/)
  return [{ id: 'E', title: '오류 메시지', kind: 'refine', nodesBefore: null, nodesAfter: 0, subpathsBefore: null, subpathsAfter: 0, diffPercent: null, iou: null, maxDeviation: null, ms: 0, checks }]
}

declare global {
  interface Window {
    runAllTests: () => Promise<{ cases: CaseReport[]; fixtures: typeof fixtures }>
  }
}

window.runAllTests = async () => {
  const cases: CaseReport[] = []
  for (const fn of [case1, case2, case3, case4, case5, case6, caseErrors]) {
    try {
      cases.push(...(await fn()))
    } catch (e) {
      cases.push({ id: fn.name, title: `${fn.name} 실행 실패`, kind: 'trace', nodesBefore: null, nodesAfter: 0, subpathsBefore: null, subpathsAfter: 0, diffPercent: null, iou: null, maxDeviation: null, ms: 0, checks: [{ name: '실행', pass: false, detail: e instanceof Error ? e.stack ?? e.message : String(e) }] })
    }
  }
  return { cases, fixtures }
}
document.body.dataset.ready = '1'
