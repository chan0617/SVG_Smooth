// SVG 파싱·정화·분석·재조립(메인 스레드, DOMParser 사용).
// 원본 문서는 절대 수정하지 않고, 결과를 만들 때마다 복제본에 path d만 교체한다.

export const MAX_SVG_BYTES = 20 * 1024 * 1024

const BLOCKED_ELEMENTS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'set', 'animate', 'animateMotion', 'animateTransform', 'handler', 'listener']
const SHAPES = ['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']
/** 이 요소 안의 path는 좌표계가 불확실하거나 형태가 결과에 미치는 영향이 커서 보정하지 않고 보존 */
const PROTECTED_CONTAINERS = ['clipPath', 'mask', 'pattern', 'marker', 'font', 'glyph']
const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

export interface SvgReport {
  paths: number
  editablePaths: number
  protectedPaths: number
  shapes: number
  texts: number
  images: number
  groups: number
  uses: number
  clips: number
  transforms: number
  removedElements: string[]
  blockedResources: number
  removedHandlers: number
  notes: string[]
}

export interface ParsedSvg {
  doc: Document
  /** querySelectorAll('path') 순서 기준, 보정 대상 path의 인덱스 */
  editable: number[]
  scales: number[]
  ds: string[]
  viewBox: { x: number; y: number; w: number; h: number }
  width: number
  height: number
  diag: number
  report: SvgReport
}

function isSafeHref(v: string) {
  const s = v.trim().toLowerCase()
  return s.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);/.test(s)
}

function cleanCss(css: string) {
  let blocked = 0
  const out = css
    .replace(/@import[^;]*;?/gi, () => { blocked++; return '' })
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, u: string) => {
      if (u.trim().startsWith('#') || /^data:image\//i.test(u.trim())) return m
      blocked++
      return 'none'
    })
    .replace(/expression\s*\(/gi, () => { blocked++; return '(' })
  return { out, blocked }
}

function parseLength(v: string | null): number | null {
  if (!v) return null
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|pt|mm|cm|in|pc)?\s*$/i.exec(v)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = (m[2] || 'px').toLowerCase()
  const f: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }
  return n * f[unit]
}

/** 정화 + 분석. 실패하면 구체적인 한국어 메시지로 throw */
export function parseSvg(text: string): ParsedSvg {
  if (text.length > MAX_SVG_BYTES) throw new Error(`SVG 파일이 너무 큽니다(최대 ${MAX_SVG_BYTES / 1024 / 1024}MB).`)
  if (!/<svg[\s>]/i.test(text)) throw new Error('SVG 루트 요소(<svg>)를 찾을 수 없습니다. 올바른 SVG 파일인지 확인해 주세요.')
  // 외부 DTD/엔티티 선언 제거(XXE·엔티티 폭탄 방지)
  const cleaned = text.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i, '')
  const doc = new DOMParser().parseFromString(cleaned, 'image/svg+xml')
  const err = doc.querySelector('parsererror')
  if (err) {
    const raw = (err.querySelector('div')?.textContent || err.textContent || '').trim()
    const m = /line (\d+) at column (\d+):\s*(.*)/i.exec(raw)
    const detail = m ? `(${m[1]}행 ${m[2]}열: ${m[3].trim().slice(0, 120)})` : raw ? `(${raw.slice(0, 120)})` : ''
    throw new Error(`SVG 구문 오류로 파일을 읽을 수 없습니다. 태그가 올바르게 닫혔는지 확인해 주세요. ${detail}`)
  }
  const root = doc.documentElement
  if (root.localName !== 'svg') throw new Error('SVG 루트 요소가 <svg>가 아닙니다.')

  const report: SvgReport = {
    paths: 0, editablePaths: 0, protectedPaths: 0, shapes: 0, texts: 0, images: 0, groups: 0, uses: 0, clips: 0, transforms: 0,
    removedElements: [], blockedResources: 0, removedHandlers: 0, notes: [],
  }

  // 1) 위험 요소 제거
  for (const name of BLOCKED_ELEMENTS) {
    const els = Array.from(doc.getElementsByTagNameNS('*', name))
    if (els.length) report.removedElements.push(`${name}×${els.length}`)
    els.forEach((el) => el.remove())
  }
  // 2) 이벤트 핸들러·외부 링크·외부 CSS 차단
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttributeNode(attr)
        report.removedHandlers++
      } else if (name === 'href' || name === 'xlink:href' || attr.localName === 'href') {
        if (!isSafeHref(attr.value)) {
          el.removeAttributeNode(attr)
          report.blockedResources++
        }
      } else if (name === 'style' || /url\(/i.test(attr.value)) {
        const { out, blocked } = cleanCss(attr.value)
        if (blocked) { attr.value = out; report.blockedResources += blocked }
      }
    }
  }
  for (const st of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    const { out, blocked } = cleanCss(st.textContent || '')
    if (blocked) { st.textContent = out; report.blockedResources += blocked }
  }

  // 3) 크기/viewBox
  const vbAttr = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  let width = parseLength(root.getAttribute('width'))
  let height = parseLength(root.getAttribute('height'))
  let viewBox: ParsedSvg['viewBox']
  if (vbAttr && vbAttr.length === 4 && vbAttr.every(Number.isFinite) && vbAttr[2] > 0 && vbAttr[3] > 0) {
    viewBox = { x: vbAttr[0], y: vbAttr[1], w: vbAttr[2], h: vbAttr[3] }
  } else if (width && height) {
    viewBox = { x: 0, y: 0, w: width, h: height }
  } else {
    viewBox = measureBBox(doc)
    root.setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`)
    report.notes.push('viewBox와 크기 정보가 없어 그림 범위로 viewBox를 지정했습니다.')
  }
  if (!width || !height) {
    const ratio = viewBox.w / viewBox.h
    if (width) height = width / ratio
    else if (height) width = height * ratio
    else { width = viewBox.w; height = viewBox.h }
  }

  // 4) 요소 분석
  const allPaths = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'path'))
  report.paths = allPaths.length
  const editable: number[] = []
  const scales: number[] = []
  const ds: string[] = []
  allPaths.forEach((p, i) => {
    const d = p.getAttribute('d')
    if (!d || !d.trim()) return
    let protectedBy: string | null = null
    for (let a: Element | null = p.parentElement; a; a = a.parentElement) {
      if (PROTECTED_CONTAINERS.includes(a.localName)) { protectedBy = a.localName; break }
    }
    if (protectedBy) { report.protectedPaths++; return }
    editable.push(i)
    scales.push(cumulativeScale(p, root))
    ds.push(d)
  })
  report.editablePaths = editable.length
  for (const s of SHAPES) report.shapes += doc.getElementsByTagNameNS(SVG_NS, s).length
  report.texts = doc.getElementsByTagNameNS(SVG_NS, 'text').length
  report.images = doc.getElementsByTagNameNS(SVG_NS, 'image').length
  report.groups = doc.getElementsByTagNameNS(SVG_NS, 'g').length
  report.uses = doc.getElementsByTagNameNS(SVG_NS, 'use').length
  report.clips = doc.getElementsByTagNameNS(SVG_NS, 'clipPath').length + doc.getElementsByTagNameNS(SVG_NS, 'mask').length
  report.transforms = doc.querySelectorAll('[transform]').length

  if (report.shapes) report.notes.push(`기본 도형 ${report.shapes}개(rect·circle 등)는 이미 정확한 형태이므로 변경하지 않고 보존합니다.`)
  if (report.texts) report.notes.push(`텍스트 ${report.texts}개는 편집 가능한 상태로 보존합니다(윤곽선 변환 안 함).`)
  if (report.protectedPaths) report.notes.push(`클리핑·마스크·패턴 내부 path ${report.protectedPaths}개는 결과 손상을 막기 위해 보존합니다.`)
  if (report.images) report.notes.push(`포함된 비트맵 이미지 ${report.images}개는 보정 대상이 아니며 그대로 보존합니다.`)
  if (report.removedElements.length) report.notes.push(`보안을 위해 제거한 요소: ${report.removedElements.join(', ')}`)
  if (report.blockedResources) report.notes.push(`외부 리소스 참조 ${report.blockedResources}개를 차단했습니다.`)
  if (report.removedHandlers) report.notes.push(`이벤트 핸들러 속성 ${report.removedHandlers}개를 제거했습니다.`)
  if (editable.length === 0) report.notes.push('보정 가능한 <path>가 없습니다. 도형·텍스트만 있는 SVG는 형태가 그대로 유지됩니다.')

  const diag = Math.hypot(viewBox.w, viewBox.h)
  return { doc, editable, scales, ds, viewBox, width, height, diag, report }
}

/** path → 루트 사용자 좌표까지 누적 transform의 면적 배율(√|det|) */
function cumulativeScale(el: Element, root: Element) {
  let m = new DOMMatrix()
  for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
    const t = (a as SVGGraphicsElement).transform?.baseVal?.consolidate?.()
    if (t) m = DOMMatrix.fromMatrix(t.matrix).multiply(m)
    if (['defs', 'symbol'].includes(a.localName)) return 1
  }
  const det = Math.abs(m.a * m.d - m.b * m.c)
  return det > 0 ? Math.sqrt(det) : 1
}

/** viewBox가 없는 SVG: 화면 밖에 임시로 붙여 getBBox로 범위를 잰다(스크립트는 이미 제거됨). */
function measureBBox(doc: Document) {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;visibility:hidden'
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement
  host.appendChild(svg)
  document.body.appendChild(host)
  try {
    const b = svg.getBBox()
    if (b.width > 0 && b.height > 0) return { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    /* 측정 실패 시 기본값 */
  } finally {
    host.remove()
  }
  return { x: 0, y: 0, w: 300, h: 150 }
}

export type ColorMode = 'original' | 'black' | 'white'

const PAINTABLE = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath'])

function effectivePaint(el: Element, prop: 'fill' | 'stroke'): string {
  for (let a: Element | null = el; a; a = a.parentElement) {
    const style = (a as SVGElement).style?.getPropertyValue?.(prop)
    if (style) return style.trim()
    const attr = a.getAttribute(prop)
    if (attr) return attr.trim()
  }
  return prop === 'fill' ? 'black' : 'none'
}

function recolor(doc: Document, color: string) {
  const els = Array.from(doc.getElementsByTagName('*')).filter((e) => PAINTABLE.has(e.localName))
  const decisions = els.map((el) => ({ el, fill: effectivePaint(el, 'fill') !== 'none', stroke: effectivePaint(el, 'stroke') !== 'none' }))
  for (const { el, fill, stroke } of decisions) {
    const st = (el as SVGElement).style
    st?.removeProperty('fill')
    st?.removeProperty('stroke')
    el.setAttribute('fill', fill ? color : 'none')
    if (stroke) el.setAttribute('stroke', color)
  }
}

/** 결과 SVG 문자열 생성. replacements: editable 인덱스 → 새 d */
export function buildSvg(parsed: ParsedSvg, replacements: Map<number, string> | null, color: ColorMode): string {
  const doc = parsed.doc.cloneNode(true) as Document
  if (replacements) {
    const paths = Array.from(doc.getElementsByTagNameNS(SVG_NS, 'path'))
    for (const [idx, d] of replacements) paths[idx]?.setAttribute('d', d)
  }
  if (color !== 'original') recolor(doc, color === 'black' ? '#000000' : '#ffffff')
  const root = doc.documentElement
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', SVG_NS)
  if (root.querySelector('[*|href]') && !root.getAttribute('xmlns:xlink')) root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS)
  return new XMLSerializer().serializeToString(doc)
}

export function serializeOriginal(parsed: ParsedSvg) {
  return buildSvg(parsed, null, 'original')
}

/** 추적 결과용 SVG(실제 path 데이터만, 비트맵 삽입 없음) */
export function buildTracedSvg(d: string, width: number, height: number, fill: string) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `  <path d="${d}" fill="${fill}" fill-rule="nonzero"/>\n` +
    `</svg>\n`
  )
}

/** 오버레이 표시용: 보정 대상 path의 d와 누적 변환 행렬(루트 사용자 좌표 기준) */
export function overlayMatrices(parsed: ParsedSvg): DOMMatrix[] {
  const paths = Array.from(parsed.doc.getElementsByTagNameNS(SVG_NS, 'path'))
  const root = parsed.doc.documentElement
  return parsed.editable.map((idx) => {
    let m = new DOMMatrix()
    for (let a: Element | null = paths[idx]; a && a !== root; a = a.parentElement) {
      const t = (a as SVGGraphicsElement).transform?.baseVal?.consolidate?.()
      if (t) m = DOMMatrix.fromMatrix(t.matrix).multiply(m)
    }
    return m
  })
}
