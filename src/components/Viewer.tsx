import { Columns2, Eye, EyeOff, Grid2x2, Loader2, Maximize, Minus, Plus, Spline, SquareDot, SplitSquareHorizontal } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { anchorPathData, type OverlayData } from '../lib/overlay'
import { IconButton, Segmented } from './ui'

export interface ViewSide {
  url: string | null
  pixelated?: boolean
  overlay: OverlayData | null
  label: string
  badge?: string
}

interface Props {
  original: ViewSide
  result: ViewSide | null
  width: number
  height: number
  viewBox: string
  processing: boolean
  fitKey: string
}

type Bg = 'checker' | 'white' | 'black'
type Mode = 'split' | 'slider'

const ZOOMS = [1, 2, 4, 8]
const MIN_Z = 0.02
const MAX_Z = 32

export function Viewer({ original, result, width, height, viewBox, processing, fitKey }: Props) {
  const [mode, setMode] = useState<Mode>('split')
  const [bg, setBg] = useState<Bg>('checker')
  const [showAnchors, setShowAnchors] = useState(false)
  const [showPaths, setShowPaths] = useState(false)
  const [z, setZ] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [divider, setDivider] = useState(0.5)
  const [panning, setPanning] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const pane = useMemo(() => (mode === 'split' ? { w: Math.max(1, (stage.w - 1) / 2), h: stage.h } : { w: stage.w, h: stage.h }), [mode, stage])

  const fit = useCallback(() => {
    if (pane.w < 10 || pane.h < 10 || !width || !height) return false
    const nz = Math.min(MAX_Z, Math.max(MIN_Z, Math.min((pane.w - 48) / width, (pane.h - 48) / height)))
    setZ(nz)
    setPan({ x: (pane.w - width * nz) / 2, y: (pane.h - height * nz) / 2 })
    return true
  }, [pane.w, pane.h, width, height])

  // 새 파일/모드 변경/크기 측정 시 화면 맞춤
  const fitted = useRef('')
  useEffect(() => {
    const key = `${fitKey}|${mode}`
    if (fitted.current !== key && fit()) fitted.current = key
  }, [fitKey, mode, fit])

  const zoomAt = useCallback(
    (nz: number, cx: number, cy: number) => {
      nz = Math.min(MAX_Z, Math.max(MIN_Z, nz))
      setPan((p) => ({ x: cx - ((cx - p.x) * nz) / z, y: cy - ((cy - p.y) * nz) / z }))
      setZ(nz)
    },
    [z],
  )
  const zoomCenter = (nz: number) => zoomAt(nz, pane.w / 2, pane.h / 2)

  // 휠 확대/축소(커서 기준). passive:false 필요
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      let cx = e.clientX - rect.left
      if (mode === 'split' && cx > pane.w) cx -= pane.w + 1
      const cy = e.clientY - rect.top
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        zoomAt(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), cx, cy)
      } else {
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [z, zoomAt, mode, pane.w])

  const drag = useRef<{ kind: 'pan' | 'divider'; sx: number; sy: number; px: number; py: number } | null>(null)
  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    const isDivider = (e.target as HTMLElement).closest('[data-divider]')
    drag.current = { kind: isDivider ? 'divider' : 'pan', sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
    setPanning(!isDivider)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') setPan({ x: d.px + e.clientX - d.sx, y: d.py + e.clientY - d.sy })
    else {
      const rect = stageRef.current!.getBoundingClientRect()
      setDivider(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)))
    }
  }
  const onPointerUp = () => {
    drag.current = null
    setPanning(false)
  }

  // 키보드: 0 = 맞춤, 1~4 = 100~800%
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey) return
      if (e.key === '0') fit()
      else if (['1', '2', '3', '4'].includes(e.key)) zoomCenter(ZOOMS[Number(e.key) - 1])
      else if (e.key === '+' || e.key === '=') zoomCenter(z * 1.25)
      else if (e.key === '-') zoomCenter(z / 1.25)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const bgClass = bg === 'checker' ? 'checker' : bg === 'white' ? 'bg-white' : 'bg-black'
  const layer = (side: ViewSide) => (
    <Layer side={side} z={z} pan={pan} width={width} height={height} viewBox={viewBox} showAnchors={showAnchors} showPaths={showPaths} />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 뷰어 도구 막대 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-800 bg-ink-900 px-3 py-1.5">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'split', label: <><Columns2 size={14} /> 2분할</>, title: '원본과 결과를 좌우로 나란히' },
            { value: 'slider', label: <><SplitSquareHorizontal size={14} /> 비교선</>, title: '겹쳐 놓고 비교선을 드래그' },
          ]}
        />
        <div className="h-5 w-px bg-ink-700" />
        <div className="flex items-center gap-0.5">
          <IconButton title="축소 (-)" onClick={() => zoomCenter(z / 1.25)}><Minus size={15} /></IconButton>
          <span className="w-14 text-center font-mono text-xs tabular-nums text-ink-200">{Math.round(z * 100)}%</span>
          <IconButton title="확대 (+)" onClick={() => zoomCenter(z * 1.25)}><Plus size={15} /></IconButton>
          <IconButton title="화면 맞춤 (0)" onClick={fit}><Maximize size={14} /></IconButton>
          {ZOOMS.map((v, i) => (
            <button
              key={v}
              type="button"
              title={`${v * 100}% (${i + 1})`}
              onClick={() => zoomCenter(v)}
              className={`rounded px-1.5 py-1 font-mono text-[11px] ${Math.abs(z - v) < 0.001 ? 'bg-ink-700 text-lime' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'}`}
            >
              {v * 100}
            </button>
          ))}
        </div>
        <div className="h-5 w-px bg-ink-700" />
        <Segmented
          size="sm"
          value={bg}
          onChange={setBg}
          options={[
            { value: 'checker', label: <Grid2x2 size={13} />, title: '투명 체크무늬 배경' },
            { value: 'white', label: <span className="h-3 w-3 rounded-sm border border-ink-500 bg-white" />, title: '흰색 배경' },
            { value: 'black', label: <span className="h-3 w-3 rounded-sm border border-ink-500 bg-black" />, title: '검정 배경' },
          ]}
        />
        <div className="flex items-center gap-0.5">
          <IconButton title="벡터 경로 표시" active={showPaths} onClick={() => setShowPaths((v) => !v)}>
            <Spline size={15} /> <span className="text-xs">경로</span>
          </IconButton>
          <IconButton title="앵커 포인트 표시" active={showAnchors} onClick={() => setShowAnchors((v) => !v)}>
            <SquareDot size={15} /> <span className="text-xs">앵커</span>
          </IconButton>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-400">
          {processing && (
            <span className="flex items-center gap-1.5 text-lime">
              <Loader2 size={14} className="animate-spin" /> 처리 중
            </span>
          )}
        </div>
      </div>

      {/* 작업 캔버스 */}
      <div
        ref={stageRef}
        className={`relative min-h-0 flex-1 touch-none overflow-hidden select-none ${mode === 'split' ? 'grid grid-cols-2 gap-px bg-ink-800' : ''} ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        {mode === 'split' ? (
          <>
            <div className={`relative overflow-hidden ${bgClass}`}>
              {layer(original)}
              <PaneLabel side={original} />
            </div>
            <div className={`relative overflow-hidden ${bgClass}`}>
              {result ? layer(result) : <EmptyResult processing={processing} />}
              {result && <PaneLabel side={result} right />}
            </div>
          </>
        ) : (
          <div className={`absolute inset-0 ${bgClass}`}>
            <div className="absolute inset-0" style={{ clipPath: `inset(0 ${(1 - divider) * 100}% 0 0)` }}>
              {layer(original)}
            </div>
            {result && (
              <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${divider * 100}%)` }}>
                {layer(result)}
              </div>
            )}
            <div data-divider className="absolute top-0 bottom-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize" style={{ left: `${divider * 100}%` }}>
              <div className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-lime shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" />
              <div className="absolute top-1/2 left-1/2 flex h-8 w-5 -translate-1/2 items-center justify-center rounded-md border border-ink-950 bg-lime text-ink-950">
                <SplitSquareHorizontal size={12} />
              </div>
            </div>
            <PaneLabel side={original} />
            {result && <PaneLabel side={result} right />}
          </div>
        )}
      </div>
    </div>
  )
}

function PaneLabel({ side, right }: { side: ViewSide; right?: boolean }) {
  return (
    <div className={`pointer-events-none absolute top-2 ${right ? 'right-2' : 'left-2'} z-20 flex items-center gap-2 rounded-md bg-ink-950/85 px-2 py-1 text-[11px] backdrop-blur`}>
      <span className="font-semibold text-ink-100">{side.label}</span>
      {side.badge && <span className="font-mono text-ink-300">{side.badge}</span>}
    </div>
  )
}

function EmptyResult({ processing }: { processing: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-ink-400">
      {processing ? <Loader2 className="animate-spin" /> : <span className="flex items-center gap-2"><EyeOff size={16} /> 결과 없음</span>}
    </div>
  )
}

function Layer({ side, z, pan, width, height, viewBox, showAnchors, showPaths }: { side: ViewSide; z: number; pan: { x: number; y: number }; width: number; height: number; viewBox: string; showAnchors: boolean; showPaths: boolean }) {
  const w = width * z, h = height * z
  const vbW = Number(viewBox.split(/\s+/)[2]) || width
  const vbH = Number(viewBox.split(/\s+/)[3]) || height
  // 문서 단위 / 화면 px (meet 기준)
  const upp = Math.max(vbW / w, vbH / h)
  const anchorD = useMemo(() => (side.overlay && showAnchors ? anchorPathData(side.overlay.anchors, 5 * upp) : ''), [side.overlay, showAnchors, upp])
  if (!side.url) return null
  return (
    <div className="pointer-events-none absolute" style={{ left: pan.x, top: pan.y, width: w, height: h }}>
      <img
        src={side.url}
        alt={side.label}
        draggable={false}
        className="block h-full w-full"
        style={{ imageRendering: side.pixelated && z >= 2 ? 'pixelated' : 'auto' }}
      />
      {side.overlay && (showPaths || showAnchors) && (
        <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox={viewBox}>
          {showPaths &&
            side.overlay.paths.map((p, i) => (
              <path key={i} d={p.d} transform={p.transform} fill="none" stroke="#96FC4D" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
          {showAnchors && anchorD && <path d={anchorD} fill="#0c0d0f" stroke="#96FC4D" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        </svg>
      )}
      {side.overlay?.truncated && showAnchors && (
        <div className="absolute -top-6 left-0 flex items-center gap-1 text-[11px] text-amber-300">
          <Eye size={12} /> 앵커가 너무 많아 일부만 표시
        </div>
      )}
    </div>
  )
}
