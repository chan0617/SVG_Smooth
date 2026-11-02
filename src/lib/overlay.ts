// 미리보기 오버레이(경로선·앵커 포인트) 데이터. 메인 스레드 Paper.js로 path d를 해석한다.
import paper from 'paper/dist/paper-core'
import { ensurePaper, subpathsOf } from '../engine/paperUtil'

export interface OverlayData {
  paths: { d: string; transform?: string }[]
  /** 루트 좌표계의 앵커 좌표 [x0, y0, x1, y1, ...] */
  anchors: Float64Array
  anchorCount: number
  truncated: boolean
}

export const MAX_OVERLAY_ANCHORS = 40000

export function buildOverlay(entries: { d: string; matrix: DOMMatrix | null }[]): OverlayData {
  ensurePaper()
  const pts: number[] = []
  let count = 0
  let truncated = false
  const paths = entries.map(({ d, matrix }) => {
    const transform = matrix && !matrix.isIdentity ? `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})` : undefined
    if (!truncated) {
      try {
        const item = paper.PathItem.create(d)
        if (matrix && !matrix.isIdentity) item.transform(new paper.Matrix(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f))
        for (const sp of subpathsOf(item)) {
          for (const s of sp.segments) {
            if (count >= MAX_OVERLAY_ANCHORS) { truncated = true; break }
            pts.push(s.point.x, s.point.y)
            count++
          }
        }
        item.remove()
      } catch {
        /* 해석 실패한 path는 앵커 표시 생략 */
      }
    }
    return { d, transform }
  })
  return { paths, anchors: Float64Array.from(pts), anchorCount: count, truncated }
}

/** 앵커를 하나의 path로 그린다(수만 개도 가볍게). size는 문서 단위 */
export function anchorPathData(a: Float64Array, size: number) {
  const h = size / 2
  let s = ''
  for (let i = 0; i < a.length; i += 2) {
    const x = a[i] - h, y = a[i + 1] - h
    s += `M${x.toFixed(2)} ${y.toFixed(2)}h${size.toFixed(3)}v${size.toFixed(3)}h${(-size).toFixed(3)}z`
  }
  return s
}
