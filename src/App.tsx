import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileImage,
  FileUp,
  GitCommitVertical,
  History,
  Image as ImageIcon,
  Info,
  Layers,
  Redo2,
  RotateCcw,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ExportDialog } from './components/ExportDialog'
import { SliderField } from './components/SliderField'
import { Section, Segmented, Stat, Toggle } from './components/ui'
import { Viewer, type ViewSide } from './components/Viewer'
import { EngineClient } from './engine/client'
import { baseName, detectKind, loadBitmap, MAX_FILE_BYTES, type LoadedBitmap } from './engine/image'
import { DEFAULT_PARAMS, DEFAULT_TRACE_OPTIONS, PRESETS, type ForegroundMode, type TraceOptions, type UiParams } from './engine/params'
import { processBitmap, processSvg, type ProcessResult } from './engine/pipeline'
import { svgToBlobUrl } from './engine/raster'
import { overlayMatrices, parseSvg, serializeOriginal, type ParsedSvg } from './engine/svgDoc'
import { buildOverlay } from './lib/overlay'

type Stage =
  | { kind: 'bitmap'; label: string; bitmap: LoadedBitmap }
  | { kind: 'svg'; label: string; parsed: ParsedSvg; matrices: DOMMatrix[]; url: string }

interface Entry {
  stage: number
  params: UiParams
  trace: TraceOptions
  label: string
}

interface Project {
  fileName: string
  fileSize: number
  stages: Stage[]
  history: Entry[]
  cursor: number
}

const MAX_HISTORY = 100

const PARAM_LABELS: Record<keyof UiParams, string> = {
  smooth: '스무스 강도',
  simplify: '패스 단순화',
  corner: '모서리 유지',
  noise: '노이즈 제거',
  precision: '곡선 정밀도',
  threshold: '이미지 임계값',
}

const SAMPLES = [
  { file: '1-black-logo-transparent.png', label: '투명 배경 로고' },
  { file: '2-lowres-staircase.png', label: '저해상도 계단' },
  { file: '3-too-many-nodes.svg', label: '노드 과다 SVG' },
  { file: '4-holes-OB8-compound.svg', label: '구멍 글자 SVG' },
  { file: '5-sharp-star-brush.png', label: '별·붓 획' },
  { file: '6-white-logo-transparent.png', label: '흰색 로고' },
]

const sameParams = (a: UiParams, b: UiParams) => (Object.keys(a) as (keyof UiParams)[]).every((k) => a[k] === b[k])
const sameTrace = (a: TraceOptions, b: TraceOptions) => a.mode === b.mode && a.invert === b.invert && a.removeBackground === b.removeBackground

function describeChange(prev: Entry, params: UiParams, trace: TraceOptions) {
  const parts = (Object.keys(params) as (keyof UiParams)[])
    .filter((k) => prev.params[k] !== params[k])
    .map((k) => `${PARAM_LABELS[k]} ${prev.params[k]}→${params[k]}`)
  if (prev.trace.mode !== trace.mode) parts.push('판정 방식 변경')
  if (prev.trace.invert !== trace.invert) parts.push(trace.invert ? '반전 켬' : '반전 끔')
  if (prev.trace.removeBackground !== trace.removeBackground) parts.push(trace.removeBackground ? '배경 제거 켬' : '배경 제거 끔')
  return parts.join(', ') || '설정 변경'
}

export default function App() {
  const client = useMemo(() => new EngineClient(), [])
  const [project, setProject] = useState<Project | null>(null)
  const [projectName, setProjectName] = useState('새 프로젝트')
  const [params, setParams] = useState<UiParams>(DEFAULT_PARAMS)
  const [trace, setTrace] = useState<TraceOptions>(DEFAULT_TRACE_OPTIONS)
  const [result, setResult] = useState<ProcessResult | null>(null)
  const [processing, setProcessing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const entry = project ? project.history[project.cursor] : null
  const stageIdx = entry?.stage ?? 0
  const stage = project?.stages[stageIdx] ?? null

  /* ---------------------------------------------------------------- 파일 열기 */
  const openFile = useCallback(async (file: File) => {
    setError(null)
    setNotice(null)
    const kind = detectKind(file)
    if (!kind) {
      setError(`지원하지 않는 파일 형식입니다: ${file.name}. PNG·JPG·WEBP·SVG 파일을 사용해 주세요.`)
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`파일이 너무 큽니다(${(file.size / 1048576).toFixed(1)}MB). 최대 ${MAX_FILE_BYTES / 1048576}MB까지 지원합니다.`)
      return
    }
    setLoading(true)
    try {
      let first: Stage
      if (kind === 'bitmap') {
        const bitmap = await loadBitmap(file)
        first = { kind: 'bitmap', label: '원본 업로드', bitmap }
      } else {
        const text = await file.text()
        const parsed = parseSvg(text)
        first = { kind: 'svg', label: '원본 업로드', parsed, matrices: overlayMatrices(parsed), url: svgToBlobUrl(serializeOriginal(parsed)) }
      }
      // 이전 프로젝트의 Blob URL 정리
      setProject((old) => {
        old?.stages.forEach((s) => URL.revokeObjectURL(s.kind === 'bitmap' ? s.bitmap.url : s.url))
        return {
          fileName: file.name,
          fileSize: file.size,
          stages: [first],
          history: [{ stage: 0, params: DEFAULT_PARAMS, trace: DEFAULT_TRACE_OPTIONS, label: '업로드' }],
          cursor: 0,
        }
      })
      setParams(DEFAULT_PARAMS)
      setTrace(DEFAULT_TRACE_OPTIONS)
      setResult(null)
      setProjectName(baseName(file.name))
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일을 여는 중 알 수 없는 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  const openSample = async (name: string) => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`)
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      await openFile(new File([blob], name, { type: name.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }))
    } catch {
      setError('샘플 파일을 불러오지 못했습니다.')
    }
  }

  // 창 전체 드래그 앤 드롭
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragOver(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragOver(false)
    }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragOver(false)
      const files = e.dataTransfer?.files
      if (files?.length) {
        if (files.length > 1) setNotice(`파일 ${files.length}개 중 첫 번째 파일(${files[0].name})만 열었습니다.`)
        void openFile(files[0])
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [openFile])

  /* ---------------------------------------------------------------- 히스토리 */
  const pushEntry = useCallback((make: (p: Project) => Entry | null) => {
    setProject((p) => {
      if (!p) return p
      const e = make(p)
      if (!e) return p
      let history = [...p.history.slice(0, p.cursor + 1), e]
      if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY)
      return { ...p, history, cursor: history.length - 1 }
    })
  }, [])

  // 슬라이더 조작이 멈추면(0.5초) 히스토리에 기록
  useEffect(() => {
    if (!project) return
    const t = setTimeout(() => {
      pushEntry((p) => {
        const cur = p.history[p.cursor]
        if (sameParams(cur.params, params) && sameTrace(cur.trace, trace)) return null
        return { stage: cur.stage, params, trace, label: describeChange(cur, params, trace) }
      })
    }, 500)
    return () => clearTimeout(t)
  }, [project, params, trace, pushEntry])

  const jumpTo = useCallback(
    (index: number) => {
      const e = project?.history[index]
      if (!project || !e) return
      setParams(e.params)
      setTrace(e.trace)
      setProject({ ...project, cursor: index })
    },
    [project],
  )

  // 아직 기록되지 않은(디바운스 대기 중) 변경이 있으면 실행 취소는 먼저 그 변경을 되돌린다
  const undo = useCallback(() => {
    if (!project || !entry) return
    if (!sameParams(entry.params, params) || !sameTrace(entry.trace, trace)) jumpTo(project.cursor)
    else jumpTo(project.cursor - 1)
  }, [project, entry, params, trace, jumpTo])
  const redo = useCallback(() => project && jumpTo(project.cursor + 1), [project, jumpTo])

  const restoreOriginal = () => {
    if (!project) return
    setParams(DEFAULT_PARAMS)
    setTrace(DEFAULT_TRACE_OPTIONS)
    pushEntry(() => ({ stage: 0, params: DEFAULT_PARAMS, trace: DEFAULT_TRACE_OPTIONS, label: '원본 복원' }))
    setNotice('업로드 직후 상태로 복원했습니다. 실행 취소로 되돌릴 수 있습니다.')
  }

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    const next = { ...params, ...preset.params }
    setParams(next)
    pushEntry((p) => ({ stage: p.history[p.cursor].stage, params: next, trace, label: `프리셋: ${preset.name}` }))
  }

  /** 현재 결과를 새 기준 SVG로 확정(단계 추가). 보정 값은 0으로 돌려 이중 적용을 막는다. */
  const commitResult = () => {
    if (!project || !result) return
    try {
      const parsed = parseSvg(result.svg)
      const st: Stage = { kind: 'svg', label: `확정 ${project.stages.length}`, parsed, matrices: overlayMatrices(parsed), url: svgToBlobUrl(serializeOriginal(parsed)) }
      const next = { ...params, smooth: 0, simplify: 0, noise: 0 }
      setProject((p) => {
        if (!p) return p
        const stages = [...p.stages, st]
        const history = [...p.history.slice(0, p.cursor + 1), { stage: stages.length - 1, params: next, trace, label: `결과 확정 → 단계 ${stages.length - 1}` }]
        return { ...p, stages, history, cursor: history.length - 1 }
      })
      setParams(next)
      setNotice('현재 결과를 새 기준으로 확정했습니다. 이제 이 결과를 다시 보정할 수 있습니다(이전 단계는 보관됨).')
    } catch (e) {
      setError(e instanceof Error ? e.message : '결과를 확정하지 못했습니다.')
    }
  }

  /* ---------------------------------------------------------------- 처리 */
  const jobRef = useRef(0)
  useEffect(() => {
    if (!stage) return
    const job = ++jobRef.current
    const t = setTimeout(async () => {
      setProcessing(true)
      try {
        const r = stage.kind === 'bitmap' ? await processBitmap(client, stage.bitmap, params, trace) : await processSvg(client, stage.parsed, params, stage.matrices)
        if (r && job === jobRef.current) {
          setResult(r)
          setError(null)
        }
      } catch (e) {
        if (job === jobRef.current) {
          setResult(null)
          setError(e instanceof Error ? e.message : '변환 중 알 수 없는 오류가 발생했습니다.')
        }
      } finally {
        if (job === jobRef.current) setProcessing(false)
      }
    }, 140)
    return () => clearTimeout(t)
  }, [stage, params, trace, client])

  /* ---------------------------------------------------------------- 단축키 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo() }
      else if (k === 's' && result) { e.preventDefault(); setExportOpen(true) }
      else if (k === 'o') { e.preventDefault(); fileInput.current?.click() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo, result])

  /* ---------------------------------------------------------------- 미리보기 데이터 */
  const resultUrl = useMemo(() => (result ? svgToBlobUrl(result.svg) : null), [result])
  useEffect(() => () => { if (resultUrl) URL.revokeObjectURL(resultUrl) }, [resultUrl])
  const resultOverlay = useMemo(() => (result ? buildOverlay(result.overlay) : null), [result])
  const originalOverlay = useMemo(
    () => (stage?.kind === 'svg' ? buildOverlay(stage.parsed.ds.map((d, i) => ({ d, matrix: stage.matrices[i] ?? null }))) : null),
    [stage],
  )

  const dims = stage ? (stage.kind === 'bitmap' ? { w: stage.bitmap.outWidth, h: stage.bitmap.outHeight } : { w: stage.parsed.width, h: stage.parsed.height }) : { w: 1, h: 1 }
  const viewBox = stage?.kind === 'svg' ? `${stage.parsed.viewBox.x} ${stage.parsed.viewBox.y} ${stage.parsed.viewBox.w} ${stage.parsed.viewBox.h}` : `0 0 ${dims.w} ${dims.h}`
  const reduction = result && result.nodesBefore ? (1 - result.nodesAfter / result.nodesBefore) * 100 : null

  const originalSide: ViewSide = stage
    ? {
        url: stage.kind === 'bitmap' ? stage.bitmap.url : stage.url,
        pixelated: stage.kind === 'bitmap',
        overlay: originalOverlay,
        label: stageIdx === 0 ? '원본' : `기준 · ${stage.label}`,
        badge: stage.kind === 'bitmap' ? `${dims.w}×${dims.h} 비트맵` : result?.nodesBefore != null ? `노드 ${result.nodesBefore.toLocaleString()}` : undefined,
      }
    : { url: null, overlay: null, label: '원본' }
  const resultSide: ViewSide | null = result
    ? {
        url: resultUrl,
        overlay: resultOverlay,
        label: '결과',
        badge: `노드 ${result.nodesAfter.toLocaleString()}${reduction != null ? ` (${reduction >= 0 ? '−' : '+'}${Math.abs(reduction).toFixed(0)}%)` : ''}`,
      }
    : null

  const activePreset = PRESETS.find((p) => (Object.keys(p.params) as (keyof typeof p.params)[]).every((k) => p.params[k] === params[k]))?.id
  const setParam = (k: keyof UiParams) => (v: number) => setParams((p) => ({ ...p, [k]: v }))
  const canUndo = !!project && (project.cursor > 0 || (!!entry && (!sameParams(entry.params, params) || !sameTrace(entry.trace, trace))))
  const canRedo = !!project && project.cursor < project.history.length - 1

  return (
    <div className="flex h-full flex-col bg-ink-950 text-ink-100">
      {/* ----------------------------------------------------------- 상단 바 */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-800 bg-ink-900 px-3">
        <div className="flex items-center gap-2 pr-2">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="h-6 w-6" />
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Vector Smooth Studio</span>
        </div>
        <div className="h-5 w-px bg-ink-700" />
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="프로젝트명"
          title="프로젝트명 (다운로드 파일명에 사용)"
          className="w-32 min-w-0 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-ink-100 outline-none hover:border-ink-700 focus:border-lime sm:w-56"
        />
        <div className="ml-auto flex items-center gap-1">
          <TopButton title="실행 취소 (⌘Z)" onClick={undo} disabled={!canUndo} icon={<Undo2 size={16} />} label="실행 취소" />
          <TopButton title="다시 실행 (⇧⌘Z)" onClick={redo} disabled={!canRedo} icon={<Redo2 size={16} />} label="재실행" />
          <TopButton title="업로드 직후 상태로 복원" onClick={restoreOriginal} disabled={!project} icon={<RotateCcw size={16} />} label="원본 복원" />
          <TopButton title="현재 결과를 새 기준으로 확정하고 이어서 보정" onClick={commitResult} disabled={!result || processing} icon={<GitCommitVertical size={16} />} label="결과 확정" />
          <button
            type="button"
            disabled={!result}
            onClick={() => setExportOpen(true)}
            className="ml-1 flex h-8 items-center gap-1.5 rounded-md bg-lime px-3 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-40"
            title="다운로드 (⌘S)"
          >
            <Download size={16} /> <span className="hidden sm:inline">다운로드</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ----------------------------------------------------------- 좌측 패널 */}
        <aside className="scroll-thin order-2 shrink-0 overflow-y-auto border-ink-800 bg-ink-900 lg:order-1 lg:w-64 lg:border-r">
          <Section title="파일" icon={<FileUp size={13} />}>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-ink-600 px-3 py-4 text-ink-300 transition-colors hover:border-lime hover:text-lime"
            >
              <Upload size={18} />
              <span className="text-xs font-medium">파일 선택 또는 드래그 앤 드롭</span>
              <span className="text-[11px] text-ink-500">PNG · JPG · WEBP · SVG</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void openFile(f)
                e.target.value = ''
              }}
            />
            {project && stage && (
              <dl className="mt-3 space-y-1 text-[11px]">
                <InfoRow k="파일" v={project.fileName} />
                <InfoRow k="유형" v={project.stages[0].kind === 'bitmap' ? '비트맵 → 벡터 추적' : 'SVG 패스 보정'} />
                <InfoRow k="크기" v={`${Math.round(dims.w)} × ${Math.round(dims.h)}`} />
                <InfoRow k="용량" v={`${(project.fileSize / 1024).toFixed(1)} KB`} />
                {stage.kind === 'svg' && <InfoRow k="구성" v={`path ${stage.parsed.report.editablePaths} · 도형 ${stage.parsed.report.shapes} · 텍스트 ${stage.parsed.report.texts} · 그룹 ${stage.parsed.report.groups}`} />}
              </dl>
            )}
          </Section>

          <Section title="프리셋" icon={<Sparkles size={13} />}>
            <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  disabled={!project}
                  onClick={() => applyPreset(p.id)}
                  className={`rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                    activePreset === p.id ? 'border-lime/70 bg-lime/10' : 'border-ink-800 bg-ink-850 hover:border-ink-600'
                  }`}
                >
                  <div className={`text-xs font-semibold ${activePreset === p.id ? 'text-lime' : 'text-ink-100'}`}>{p.name}</div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-400">{p.description}</div>
                </button>
              ))}
            </div>
          </Section>

          {project && (
            <Section title="처리 단계 · 기록" icon={<History size={13} />}>
              <div className="mb-2 flex flex-wrap gap-1">
                {project.stages.map((s, i) => (
                  <span key={i} className={`rounded px-1.5 py-0.5 text-[10px] ${i === stageIdx ? 'bg-lime/15 text-lime' : 'bg-ink-800 text-ink-400'}`}>
                    {i}. {s.label}
                  </span>
                ))}
              </div>
              <ol className="scroll-thin max-h-56 space-y-0.5 overflow-y-auto">
                {project.history.map((h, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => jumpTo(i)}
                      className={`w-full truncate rounded px-2 py-1 text-left text-[11px] ${
                        i === project.cursor ? 'bg-ink-700 text-ink-100' : i > project.cursor ? 'text-ink-500 hover:bg-ink-800' : 'text-ink-300 hover:bg-ink-800'
                      }`}
                      title={h.label}
                    >
                      <span className="mr-1 font-mono text-ink-500">{i}</span>
                      {h.label}
                    </button>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </aside>

        {/* ----------------------------------------------------------- 중앙 캔버스 */}
        <main className="relative order-1 flex min-h-[60vh] min-w-0 flex-1 flex-col lg:order-2 lg:min-h-0">
          {(error || notice) && (
            <div className="absolute top-12 left-1/2 z-30 w-[min(560px,calc(100%-24px))] -translate-x-1/2 space-y-2">
              {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
              {notice && <Banner tone="info" onClose={() => setNotice(null)}>{notice}</Banner>}
            </div>
          )}
          {stage ? (
            <Viewer
              original={originalSide}
              result={resultSide}
              width={dims.w}
              height={dims.h}
              viewBox={viewBox}
              processing={processing || loading}
              fitKey={`${project?.fileName}|${stageIdx}|${dims.w}x${dims.h}`}
            />
          ) : (
            <EmptyState loading={loading} onPick={() => fileInput.current?.click()} onSample={openSample} />
          )}
        </main>

        {/* ----------------------------------------------------------- 우측 패널 */}
        <aside className="scroll-thin order-3 shrink-0 overflow-y-auto border-ink-800 bg-ink-900 lg:w-80 lg:border-l">
          <Section
            title={stage?.kind === 'bitmap' ? '벡터 추적 · 보정' : 'SVG 경로 보정'}
            icon={<SlidersHorizontal size={13} />}
            right={
              <button type="button" className="text-[11px] text-ink-400 hover:text-lime" onClick={() => setParams((p) => ({ ...DEFAULT_PARAMS, threshold: p.threshold }))}>
                기본값
              </button>
            }
          >
            <SliderField label="스무스 강도" value={params.smooth} defaultValue={35} onChange={setParam('smooth')} hint="울퉁불퉁한 외곽선을 매끄럽게. 모서리로 판정된 점은 둥글게 만들지 않습니다." />
            <SliderField label="패스 단순화" value={params.simplify} defaultValue={20} onChange={setParam('simplify')} hint="허용 오차를 키워 앵커 포인트 수를 줄입니다." />
            <SliderField label="모서리 유지" value={params.corner} defaultValue={80} onChange={setParam('corner')} hint="높을수록 덜 꺾인 모서리까지 날카롭게 보존합니다." />
            <SliderField label="노이즈 제거" value={params.noise} defaultValue={15} onChange={setParam('noise')} hint="작은 얼룩 조각 제거. 구멍은 더 엄격한 기준으로 보호합니다." />
            <SliderField label="곡선 정밀도" value={params.precision} defaultValue={85} onChange={setParam('precision')} hint="샘플링 밀도와 최소 허용 오차. 높을수록 원본에 가깝습니다." />
            <p className="mt-2 text-[11px] leading-relaxed text-ink-500">라벨을 더블클릭하면 기본값으로 돌아갑니다. 숫자 칸에서 ↑↓(Shift: ×10)로 조절할 수 있습니다.</p>
          </Section>

          {stage?.kind === 'bitmap' && (
            <Section title="이미지 추적 옵션" icon={<ScanLine size={13} />}>
              <SliderField label="이미지 임계값" value={params.threshold} min={0} max={255} defaultValue={128} onChange={setParam('threshold')} hint="밝기(또는 투명도) 기준 흑백 분리 경계" />
              <div className="mt-2 mb-1 text-ink-200">전경 판정 방식</div>
              <Segmented<ForegroundMode>
                value={trace.mode}
                onChange={(mode) => setTrace((t) => ({ ...t, mode }))}
                options={[
                  { value: 'auto', label: '자동', title: '투명 픽셀이 있으면 투명도, 없으면 밝기' },
                  { value: 'luminance', label: '밝기', title: '어두운 부분을 전경으로' },
                  { value: 'alpha', label: '투명도', title: '불투명한 부분을 전경으로(흰색 로고 등)' },
                ]}
              />
              <div className="mt-2">
                <Toggle label="검정/흰색 반전" checked={trace.invert} onChange={(invert) => setTrace((t) => ({ ...t, invert }))} />
                <Toggle label="배경 제거" checked={trace.removeBackground} onChange={(removeBackground) => setTrace((t) => ({ ...t, removeBackground }))} hint="테두리와 이어진 배경색 영역을 제거(밝기 모드)" />
              </div>
            </Section>
          )}

          <Section title="결과 분석" icon={<Layers size={13} />}>
            {result ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="앵커 포인트"
                    value={result.nodesAfter.toLocaleString()}
                    sub={result.nodesBefore != null ? `원본 ${result.nodesBefore.toLocaleString()}` : '추적 결과'}
                    tone={reduction == null ? undefined : reduction > 0 ? 'good' : reduction < 0 ? 'warn' : undefined}
                  />
                  <Stat
                    label="노드 감소율"
                    value={reduction != null ? `${reduction >= 0 ? '−' : '+'}${Math.abs(reduction).toFixed(1)}%` : '—'}
                    sub={reduction != null && reduction < 0 ? '노드가 늘었습니다' : reduction != null && reduction === 0 ? '변화 없음' : undefined}
                    tone={reduction == null ? undefined : reduction > 0 ? 'good' : reduction < 0 ? 'warn' : undefined}
                  />
                  <Stat
                    label="형태 차이"
                    value={result.diff ? `${result.diff.diffPercent.toFixed(2)}%` : '—'}
                    sub={result.diff ? `IoU ${(result.diff.iou * 100).toFixed(2)}%` : undefined}
                    tone={result.diff ? (result.diff.diffPercent < 2 ? 'good' : result.diff.diffPercent < 6 ? 'warn' : 'bad') : undefined}
                  />
                  <Stat label="서브패스" value={result.subpathsAfter.toLocaleString()} sub={result.subpathsBefore != null ? `원본 ${result.subpathsBefore.toLocaleString()}` : '구멍 포함'} />
                  {result.meanDeviation != null && (
                    <Stat label="윤곽 편차(평균)" value={result.meanDeviation.toFixed(2)} sub={`최대 ${result.maxDeviation!.toFixed(2)} (문서 단위)`} />
                  )}
                  <Stat label="처리 시간" value={`${Math.round(result.elapsedMs)}ms`} sub="Web Worker" />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                  형태 차이 = 원본과 결과를 같은 해상도(긴 변 512px)로 래스터화해 달라진 픽셀 수 ÷ 원본 면적.
                </p>
                {result.messages.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {result.messages.map((m, i) => (
                      <li key={i} className="flex gap-2 text-[11px] leading-snug text-ink-300">
                        <Info size={12} className="mt-0.5 shrink-0 text-ink-500" />
                        {m}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-[11px] text-ink-500">{project ? (processing ? '계산 중…' : '결과가 없습니다.') : '파일을 열면 원본과 결과를 비교한 수치가 표시됩니다.'}</p>
            )}
          </Section>
        </aside>
      </div>

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-lime px-10 py-8 text-center">
            <FileImage className="mx-auto mb-2 text-lime" size={32} />
            <div className="text-base font-semibold text-lime">여기에 놓아 파일 열기</div>
            <div className="mt-1 text-xs text-ink-300">PNG · JPG · WEBP → 벡터 추적 / SVG → 경로 보정</div>
          </div>
        </div>
      )}

      {exportOpen && result && <ExportDialog result={result} baseName={baseName(projectName || 'vector')} onClose={() => setExportOpen(false)} onError={setError} />}
    </div>
  )
}

function TopButton({ title, onClick, disabled, icon, label }: { title: string; onClick: () => void; disabled?: boolean; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-200 hover:bg-ink-700 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-35"
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
    </button>
  )
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-ink-500">{k}</dt>
      <dd className="min-w-0 break-all text-ink-200">{v}</dd>
    </div>
  )
}

function Banner({ tone, children, onClose }: { tone: 'error' | 'info'; children: ReactNode; onClose: () => void }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs shadow-xl backdrop-blur ${
        tone === 'error' ? 'border-red-500/40 bg-red-950/90 text-red-100' : 'border-lime/30 bg-ink-850/95 text-ink-100'
      }`}
    >
      {tone === 'error' ? <AlertTriangle size={15} className="mt-px shrink-0 text-red-400" /> : <CheckCircle2 size={15} className="mt-px shrink-0 text-lime" />}
      <div className="flex-1 leading-relaxed">{children}</div>
      <button type="button" onClick={onClose} className="shrink-0 rounded p-0.5 hover:bg-white/10" aria-label="닫기">
        <X size={13} />
      </button>
    </div>
  )
}

function EmptyState({ loading, onPick, onSample }: { loading: boolean; onPick: () => void; onSample: (f: string) => void }) {
  return (
    <div className="checker flex h-full items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-ink-700 bg-ink-900/95 p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-lime/10 text-lime">
          <ImageIcon size={22} />
        </div>
        <h1 className="text-lg font-semibold">이미지를 벡터로, 벡터를 더 매끄럽게</h1>
        <p className="mt-2 text-xs leading-relaxed text-ink-300">
          PNG·JPG·WEBP는 Potrace로 실제 베지어 path를 추적하고, SVG는 Paper.js로 앵커를 줄이며 모서리는 보존해 다듬습니다.
          모든 처리는 이 컴퓨터 안에서만 이루어집니다.
        </p>
        <button type="button" onClick={onPick} disabled={loading} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-lime px-4 py-2.5 text-sm font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50">
          <Upload size={16} /> {loading ? '여는 중…' : '파일 열기'}
        </button>
        <div className="mt-2 text-[11px] text-ink-500">또는 창 아무 곳에나 파일을 끌어다 놓으세요 · ⌘O</div>
        <div className="mt-6 border-t border-ink-800 pt-4">
          <div className="mb-2 text-[11px] text-ink-400">테스트 샘플</div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {SAMPLES.map((s) => (
              <button key={s.file} type="button" onClick={() => onSample(s.file)} className="rounded-md border border-ink-700 px-2.5 py-1 text-[11px] text-ink-200 hover:border-lime hover:text-lime">
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
