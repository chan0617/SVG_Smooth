// 기존 SVG path 보정 엔진(Paper.js). Web Worker에서 실행된다.
//
// 서브패스마다:
//  1) 노이즈 조각 제거(구멍은 기준 면적의 1/4만 적용해 보호)
//  2) 호 길이 기준 균일 재샘플링
//  3) 관찰 창(window) 기반 꺾임각으로 모서리 검출 → 원본 앵커로 스냅(뾰족한 끝 좌표 그대로 유지)
//  4) 모서리 사이 구간만 가우시안 스무딩(끝점 홀수 반사 → 끝점 고정) + 수축 보정(Taubin 방식)
//  5) 구간별 Schneider 커브 피팅(Paper.js simplify)으로 앵커 축소, 직선 구간은 직선으로 정리
//  6) 면적 변화가 크거나 노드가 늘면 원본 서브패스로 되돌림(형태 보호)
import paper from 'paper/dist/paper-core'
import { mapRefineParams, type RefineEngineParams, type UiParams } from './params'
import { ensurePaper, pathDataOf, subpathsOf } from './paperUtil'

export interface RefinePathJob {
  id: number
  d: string
  /** 이 path의 로컬 좌표 1단위가 루트(viewBox) 좌표로 몇 단위인지(누적 transform의 배율) */
  scale: number
}

export interface RefineInput {
  paths: RefinePathJob[]
  diag: number
  params: UiParams
}

export interface RefinedPath {
  id: number
  d: string
  changed: boolean
  nodesBefore: number
  nodesAfter: number
  subpathsBefore: number
  subpathsAfter: number
  removedNoise: number
  fallbacks: number
  error?: string
}

export interface RefineResult {
  paths: RefinedPath[]
  /** 원본 윤곽 대비 결과 윤곽의 편차(루트 좌표 단위) */
  meanDeviation: number
  maxDeviation: number
  corners: number
}

type Pt = { x: number; y: number }

export function refinePaths(input: RefineInput): RefineResult {
  ensurePaper()
  const out: RefinedPath[] = []
  const dev = { sum: 0, n: 0, max: 0 }
  let corners = 0
  for (const job of input.paths) {
    const scale = job.scale > 1e-9 && Number.isFinite(job.scale) ? job.scale : 1
    // 루트 좌표 기준 매개변수 → 이 path의 로컬 좌표 기준
    const root = mapRefineParams(input.params, input.diag)
    const ep: RefineEngineParams = {
      ...root,
      sampleStep: root.sampleStep / scale,
      smoothSigma: root.smoothSigma / scale,
      fitTolerance: root.fitTolerance / scale,
      cornerWindow: root.cornerWindow / scale,
      noiseArea: root.noiseArea / (scale * scale),
    }
    try {
      const r = refineOne(job, ep, scale, dev)
      corners += r.corners
      out.push(r.path)
    } catch (e) {
      out.push({
        id: job.id,
        d: job.d,
        changed: false,
        nodesBefore: 0,
        nodesAfter: 0,
        subpathsBefore: 0,
        subpathsAfter: 0,
        removedNoise: 0,
        fallbacks: 0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    paper.project.activeLayer.removeChildren()
  }
  return { paths: out, meanDeviation: dev.n ? dev.sum / dev.n : 0, maxDeviation: dev.max, corners }
}

function refineOne(job: RefinePathJob, ep: RefineEngineParams, scale: number, dev: { sum: number; n: number; max: number }) {
  const item = paper.PathItem.create(job.d) as paper.PathItem
  const subs = subpathsOf(item).slice()
  const nodesBefore = subs.reduce((n, p) => n + p.segments.length, 0)
  const result: RefinedPath = {
    id: job.id,
    d: job.d,
    changed: false,
    nodesBefore,
    nodesAfter: nodesBefore,
    subpathsBefore: subs.length,
    subpathsAfter: subs.length,
    removedNoise: 0,
    fallbacks: 0,
  }
  let cornerCount = 0
  if (!ep.geometryEnabled && ep.noiseArea <= 0) return { path: result, corners: 0 }

  // 1) 노이즈 제거
  const keep: paper.Path[] = []
  const areas = subs.map((p) => Math.abs(p.area))
  subs.forEach((p, i) => {
    if (ep.noiseArea > 0 && p.closed && areas[i] < ep.noiseArea) {
      const hole = isHole(p, i, subs, areas)
      if (!hole || areas[i] < ep.noiseArea / 4) {
        result.removedNoise++
        return
      }
    }
    keep.push(p)
  })
  if (keep.length === 0) {
    // 전부 노이즈로 판정되면 파괴하지 않고 원본 유지
    result.removedNoise = 0
    return { path: result, corners: 0 }
  }

  // 2~6) 형태 보정
  const newSubs: paper.Path[] = []
  for (const p of keep) {
    if (!ep.geometryEnabled || p.segments.length < 2) {
      newSubs.push(p.clone({ insert: false }) as paper.Path)
      continue
    }
    const r = refineSubpath(p, ep)
    if (!r) {
      newSubs.push(p.clone({ insert: false }) as paper.Path)
      continue
    }
    if (!acceptable(p, r.path)) {
      result.fallbacks++
      newSubs.push(p.clone({ insert: false }) as paper.Path)
      continue
    }
    cornerCount += r.corners
    measureDeviation(p, r.path, scale, dev)
    newSubs.push(r.path)
  }

  const cp = new paper.CompoundPath({ children: newSubs, insert: false })
  result.d = pathDataOf(cp, ep.decimals)
  result.nodesAfter = newSubs.reduce((n, p) => n + p.segments.length, 0)
  result.subpathsAfter = newSubs.length
  result.changed = true
  return { path: result, corners: cornerCount }
}

function isHole(p: paper.Path, i: number, subs: paper.Path[], areas: number[]) {
  const pt = p.interiorPoint ?? p.firstSegment.point
  let depth = 0
  for (let j = 0; j < subs.length; j++) {
    if (j === i || areas[j] <= areas[i] || !subs[j].closed) continue
    if (!subs[j].bounds.contains(pt)) continue
    if (subs[j].contains(pt)) depth++
  }
  return depth % 2 === 1
}

/** 면적/방향이 크게 바뀌면 거부(작은 구멍과 가는 획이 녹아 사라지는 것 방지) */
function acceptable(orig: paper.Path, res: paper.Path) {
  if (res.segments.length > orig.segments.length) return false
  if (!orig.closed) return true
  const a0 = orig.area, a1 = res.area
  if (Math.abs(a0) < 1e-9) return true
  if (Math.sign(a0) !== Math.sign(a1)) return false
  return Math.abs(a1 - a0) / Math.abs(a0) <= 0.2
}

function measureDeviation(orig: paper.Path, res: paper.Path, scale: number, dev: { sum: number; n: number; max: number }) {
  if (orig.curves.length > 4000) return
  const len = res.length
  if (!(len > 0)) return
  const N = 48
  for (let i = 0; i < N; i++) {
    const pt = res.getPointAt((len * i) / N)
    if (!pt) continue
    const near = orig.getNearestPoint(pt)
    if (!near) continue
    const d = near.getDistance(pt) * scale
    dev.sum += d
    dev.n++
    if (d > dev.max) dev.max = d
  }
}

interface Sampled {
  pts: Pt[]
  /** 샘플 인덱스 → 원본 앵커였으면 해당 앵커의 접선 꺾임각(도), 아니면 -1 */
  anchorTurn: number[]
  closed: boolean
}

function sample(p: paper.Path, step: number): Sampled {
  const closed = p.closed
  const total = p.length
  // 서브패스당 샘플 수 상한(성능)
  const st = Math.max(step, total / 20000)
  const pts: Pt[] = []
  const anchorTurn: number[] = []
  const curves = p.curves
  for (let ci = 0; ci < curves.length; ci++) {
    const c = curves[ci]
    const len = c.length
    const n = Math.max(1, Math.ceil(len / st))
    const prev = ci > 0 ? curves[ci - 1] : closed ? curves[curves.length - 1] : null
    let turn = -1
    if (prev) {
      const tIn = prev.getTangentAtTime(1)
      const tOut = c.getTangentAtTime(0)
      turn = tIn && tOut && !tIn.isZero() && !tOut.isZero() ? Math.abs(tIn.getDirectedAngle(tOut)) : 0
    }
    for (let i = 0; i < n; i++) {
      const pt = i === 0 ? c.point1 : c.getPointAt((len * i) / n)
      if (!pt) continue
      pts.push({ x: pt.x, y: pt.y })
      anchorTurn.push(i === 0 ? (prev ? turn : 0) : -1)
    }
  }
  if (!closed) {
    const last = p.lastSegment.point
    pts.push({ x: last.x, y: last.y })
    anchorTurn.push(0)
  }
  return { pts, anchorTurn, closed }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

/** 관찰 창 w로 각 샘플의 꺾임각을 계산하고 모서리 인덱스를 고른다. */
function findCorners(s: Sampled, ep: RefineEngineParams): number[] {
  const { pts, closed } = s
  const N = pts.length
  if (ep.cornerAngle >= 180 || N < 5) return []
  // 누적 호 길이
  const S = new Float64Array(N + 1)
  for (let i = 1; i <= N; i++) S[i] = S[i - 1] + dist(pts[i - 1], pts[i % N])
  const L = closed ? S[N] : S[N - 1]
  const w = Math.min(ep.cornerWindow, L / 4)
  if (!(w > 0)) return []
  const theta = new Float64Array(N)
  const at = (i: number) => pts[((i % N) + N) % N]
  const arc = (i: number, j: number) => {
    // i에서 j까지 진행 방향 호 길이
    if (!closed) return Math.abs(S[j] - S[i])
    const ii = ((i % N) + N) % N, jj = ((j % N) + N) % N
    return jj >= ii ? S[jj] - S[ii] : L - S[ii] + S[jj]
  }
  for (let i = 0; i < N; i++) {
    if (!closed && (i === 0 || i === N - 1)) continue
    // 뒤쪽/앞쪽으로 호 길이 w 이상 떨어진 첫 샘플
    let bi = i - 1
    while (bi > i - N && arc(bi, i) < w && (closed || bi > 0)) bi--
    let fi = i + 1
    while (fi < i + N && arc(i, fi) < w && (closed || fi < N - 1)) fi++
    const a = at(bi), b = at(i), c = at(fi)
    const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y
    const n1 = Math.hypot(v1x, v1y), n2 = Math.hypot(v2x, v2y)
    if (n1 < 1e-12 || n2 < 1e-12) continue
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (n1 * n2)))
    theta[i] = (Math.acos(cos) * 180) / Math.PI
  }
  // 임계각 초과 후보에 비최대 억제(창 안에서 가장 큰 꺾임만 남김)
  const cand: number[] = []
  for (let i = 0; i < N; i++) if (theta[i] > ep.cornerAngle) cand.push(i)
  cand.sort((a, b) => theta[b] - theta[a])
  const taken = new Uint8Array(N)
  const result: number[] = []
  for (const i of cand) {
    if (taken[i]) continue
    // 창 안 원본 앵커 중 접선 꺾임이 가장 큰 곳으로 스냅 → 뾰족한 끝 좌표 보존
    let best = i, bestTurn = s.anchorTurn[i] >= 0 ? s.anchorTurn[i] : -1
    for (let d = -1; d >= -N; d--) {
      if (!closed && i + d < 0) break
      if (arc(i + d, i) > w / 2) break
      const j = ((i + d) % N + N) % N
      if (s.anchorTurn[j] > bestTurn) { bestTurn = s.anchorTurn[j]; best = j }
    }
    for (let d = 1; d < N; d++) {
      if (!closed && i + d >= N) break
      if (arc(i, i + d) > w / 2) break
      const j = (i + d) % N
      if (s.anchorTurn[j] > bestTurn) { bestTurn = s.anchorTurn[j]; best = j }
    }
    if (bestTurn < 10) best = i
    result.push(best)
    // 창 범위 억제
    for (let d = 0; d < N; d++) {
      const j1 = closed ? (i + d) % N : i + d
      if ((!closed && j1 >= N) || arc(i, i + d) > w) break
      taken[j1] = 1
    }
    for (let d = 0; d < N; d++) {
      const j2 = closed ? (((i - d) % N) + N) % N : i - d
      if ((!closed && j2 < 0) || arc(i - d, i) > w) break
      taken[j2] = 1
    }
  }
  return [...new Set(result)].sort((a, b) => a - b)
}

/** 가우시안 이동평균. cyclic=false면 끝점 기준 홀수 반사로 끝점을 고정한다. */
function gaussian(pts: Pt[], sigma: number, step: number, cyclic: boolean): Pt[] {
  const n = pts.length
  if (sigma <= 0 || n < 3) return pts.slice()
  const r = Math.min(Math.ceil((3 * sigma) / step), cyclic ? Math.floor((n - 1) / 2) : 4 * n)
  if (r < 1) return pts.slice()
  const wts = new Float64Array(r + 1)
  for (let k = 0; k <= r; k++) wts[k] = Math.exp(-((k * step) ** 2) / (2 * sigma * sigma))
  const get = (i: number): Pt => {
    if (cyclic) return pts[((i % n) + n) % n]
    if (i >= 0 && i < n) return pts[i]
    // 홀수 반사: P(-k) = 2P(0) − P(k)
    if (i < 0) {
      const m = pts[Math.min(n - 1, -i)]
      return { x: 2 * pts[0].x - m.x, y: 2 * pts[0].y - m.y }
    }
    const m = pts[Math.max(0, 2 * (n - 1) - i)]
    return { x: 2 * pts[n - 1].x - m.x, y: 2 * pts[n - 1].y - m.y }
  }
  const out: Pt[] = new Array(n)
  for (let i = 0; i < n; i++) {
    if (!cyclic && (i === 0 || i === n - 1)) { out[i] = pts[i]; continue }
    let sx = 0, sy = 0, sw = 0
    for (let k = -r; k <= r; k++) {
      const p = get(i + k), wk = wts[Math.abs(k)]
      sx += p.x * wk; sy += p.y * wk; sw += wk
    }
    out[i] = { x: sx / sw, y: sy / sw }
  }
  return out
}

/** 노이즈는 제거하고 저주파 수축은 되돌리는 2단계 스무딩 */
function smoothRun(pts: Pt[], sigma: number, step: number, cyclic: boolean): Pt[] {
  if (sigma <= 0) return pts
  const q = gaussian(pts, sigma, step, cyclic)
  const g = gaussian(q, sigma, step, cyclic)
  const lambda = 0.85
  return q.map((p, i) => ({ x: p.x - lambda * (g[i].x - p.x), y: p.y - lambda * (g[i].y - p.y) }))
}

function fitRun(pts: Pt[], tol: number, closed: boolean): paper.Segment[] {
  // Paper.js의 닫힌 패스 simplify는 시작점 이음매 곡선을 피팅하지 않아 큰 오차가 생길 수 있다.
  // 그래서 닫힌 루프도 시작점을 끝에 한 번 더 붙인 열린 패스로 피팅하고 이음매 접선을 직접 맞춘다.
  const src = closed ? [...pts, pts[0]] : pts
  const path = new paper.Path({ segments: src.map((p) => [p.x, p.y]), insert: false })
  // Paper.js PathFitter는 "제곱 거리"와 비교하므로 tol²을 넘긴다.
  path.simplify(Math.max(1e-6, tol * tol))
  const segs = path.segments.map((s) => s.clone())
  if (closed && segs.length > 2) {
    const last = segs.pop()!
    const first = segs[0]
    first.handleIn = last.handleIn
    // 이음매에서 매끄럽게: 중심 차분 접선 방향으로 양쪽 핸들 정렬
    const n = pts.length
    const t = new paper.Point(pts[1 % n].x - pts[n - 1].x, pts[1 % n].y - pts[n - 1].y)
    if (!t.isZero()) {
      const dir = t.normalize()
      first.handleOut = dir.multiply(first.handleOut.length)
      first.handleIn = dir.multiply(-first.handleIn.length)
    }
  }
  straighten(segs, closed, tol)
  return segs
}

/** 핸들이 현(chord) 위에 거의 놓인 곡선은 직선으로 정리(로고 직선 보존, Illustrator 편집성) */
function straighten(segs: paper.Segment[], closed: boolean, tol: number) {
  const count = closed ? segs.length : segs.length - 1
  for (let i = 0; i < count; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length]
    const p0 = a.point, p3 = b.point
    const chord = p3.subtract(p0)
    const len = chord.length
    if (len < 1e-9) continue
    const h1 = p0.add(a.handleOut), h2 = p3.add(b.handleIn)
    const off = (h: paper.Point) => Math.abs(chord.cross(h.subtract(p0))) / len
    const along = (h: paper.Point) => chord.dot(h.subtract(p0)) / (len * len)
    const lim = tol * 0.25
    if (off(h1) < lim && off(h2) < lim && along(h1) >= -0.01 && along(h1) <= 1.01 && along(h2) >= -0.01 && along(h2) <= 1.01) {
      a.handleOut = new paper.Point(0, 0)
      b.handleIn = new paper.Point(0, 0)
    }
  }
}

function refineSubpath(p: paper.Path, ep: RefineEngineParams): { path: paper.Path; corners: number } | null {
  const step = ep.smoothSigma > 0 ? Math.min(ep.sampleStep, ep.smoothSigma / 3) : ep.sampleStep
  const s = sample(p, step)
  const N = s.pts.length
  if (N < 3) return null
  const realStep = Math.max(1e-9, p.length / Math.max(1, s.closed ? N : N - 1))
  // 모서리 검출은 지터에 속지 않도록 약하게 스무딩한 사본에서 하고(창 기반 꺾임각),
  // 위치는 findCorners 안에서 원본 앵커로 다시 스냅한다.
  const sigmaC = Math.max(ep.smoothSigma * 0.5, realStep * 1.5, ep.fitTolerance)
  const detect = { ...s, pts: gaussian(s.pts, sigmaC, realStep, s.closed) }
  const corners = findCorners(detect, ep)

  let tol = ep.fitTolerance
  for (let attempt = 0; attempt < 4; attempt++) {
    const segs = buildFromRuns(s, corners, ep.smoothSigma, realStep, tol)
    if (segs.length >= 2 || (!s.closed && segs.length >= 2)) {
      const path = new paper.Path({ segments: segs, closed: s.closed, insert: false })
      if (path.segments.length <= p.segments.length || attempt === 3) return { path, corners: corners.length }
    }
    tol *= 1.8 // 노드가 늘었으면 오차를 키워 다시 피팅
  }
  return null
}

function buildFromRuns(s: Sampled, corners: number[], sigma: number, step: number, tol: number): paper.Segment[] {
  const { pts, closed } = s
  const N = pts.length
  if (closed && corners.length === 0) {
    const sm = smoothRun(pts, sigma, step, true)
    return fitRun(sm, tol, true)
  }
  // 구간 경계: 열린 패스는 양 끝 + 모서리, 닫힌 패스는 모서리를 순환
  const bounds = closed ? corners : [...new Set([0, ...corners, N - 1])].sort((a, b) => a - b)
  const runs: Pt[][] = []
  const nRuns = closed ? bounds.length : bounds.length - 1
  for (let k = 0; k < nRuns; k++) {
    const a = bounds[k]
    const b = closed ? bounds[(k + 1) % bounds.length] : bounds[k + 1]
    const run: Pt[] = []
    let i = a
    for (;;) {
      run.push(pts[i])
      if (i === b && run.length > 1) break
      i = (i + 1) % N
      if (run.length > N + 1) break
    }
    runs.push(run)
  }
  const out: paper.Segment[] = []
  for (let k = 0; k < runs.length; k++) {
    const run = runs[k]
    const sm = run.length > 2 ? smoothRun(run, sigma, step, false) : run
    const segs = run.length > 2 ? fitRun(sm, tol, false) : sm.map((p) => new paper.Segment(new paper.Point(p.x, p.y)))
    if (out.length === 0) {
      out.push(...segs)
    } else {
      // 앞 구간의 마지막 점(=모서리)과 합친다: handleIn은 앞 구간, handleOut은 이번 구간
      const last = out[out.length - 1]
      last.handleOut = segs[0].handleOut
      out.push(...segs.slice(1))
    }
  }
  if (closed && out.length > 1) {
    // 마지막 점은 첫 모서리와 같은 점
    const last = out.pop()!
    out[0].handleIn = last.handleIn
  }
  return out
}
