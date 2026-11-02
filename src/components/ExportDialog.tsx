import { Download, FileImage, FileCode2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { svgToBlobUrl, svgToPngBlob } from '../engine/raster'
import type { ColorMode } from '../engine/svgDoc'
import type { ProcessResult } from '../engine/pipeline'
import { Segmented } from './ui'

interface Props {
  result: ProcessResult
  baseName: string
  onClose: () => void
  onError: (msg: string) => void
}

type Format = 'svg' | 'png'

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function ExportDialog({ result, baseName, onClose, onError }: Props) {
  const [format, setFormat] = useState<Format>('svg')
  const [scale, setScale] = useState<'1' | '2' | '4'>('2')
  const [color, setColor] = useState<ColorMode>('original')
  const [bg, setBg] = useState<'checker' | 'white' | 'black'>('checker')
  const [busy, setBusy] = useState(false)

  const svg = useMemo(() => result.render(color), [result, color])
  const previewUrl = useMemo(() => svgToBlobUrl(svg), [svg])
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl])

  const suffix = result.kind === 'trace' ? 'vector' : 'smooth'
  const colorSuffix = color === 'original' ? '' : `_${color}`
  const fileName = format === 'svg' ? `${baseName}_${suffix}${colorSuffix}.svg` : `${baseName}_${suffix}${colorSuffix}@${scale}x.png`
  const px = { w: Math.round(result.width * Number(scale)), h: Math.round(result.height * Number(scale)) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const download = async () => {
    setBusy(true)
    try {
      if (format === 'svg') {
        save(new Blob([svg], { type: 'image/svg+xml' }), fileName)
      } else {
        save(await svgToPngBlob(svg, result.width, result.height, Number(scale)), fileName)
      }
      onClose()
    } catch (e) {
      onError(e instanceof Error ? e.message : '다운로드에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const bgClass = bg === 'checker' ? 'checker' : bg === 'white' ? 'bg-white' : 'bg-black'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="결과 다운로드" className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="text-sm font-semibold">결과 다운로드</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-ink-300 hover:bg-ink-700" aria-label="닫기">
            <X size={16} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 gap-0 overflow-auto md:grid-cols-[1fr_280px]">
          <div className="flex min-h-[260px] flex-col border-b border-ink-800 md:border-r md:border-b-0">
            <div className={`relative flex flex-1 items-center justify-center p-6 ${bgClass}`}>
              <img src={previewUrl} alt="다운로드 미리보기" className="max-h-[50vh] max-w-full object-contain" />
            </div>
            <div className="flex items-center justify-between border-t border-ink-800 px-4 py-2 text-[11px] text-ink-400">
              <span>미리보기</span>
              <Segmented size="sm" value={bg} onChange={setBg} options={[{ value: 'checker', label: '투명' }, { value: 'white', label: '흰색' }, { value: 'black', label: '검정' }]} />
            </div>
          </div>
          <div className="space-y-5 p-5">
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">형식</div>
              <div className="grid grid-cols-2 gap-2">
                {(['svg', 'png'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFormat(f)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left ${format === f ? 'border-lime bg-lime/10 text-lime' : 'border-ink-700 text-ink-200 hover:border-ink-500'}`}
                  >
                    {f === 'svg' ? <FileCode2 size={16} /> : <FileImage size={16} />}
                    <span>
                      <span className="block font-semibold">{f.toUpperCase()}</span>
                      <span className="block text-[11px] text-ink-400">{f === 'svg' ? '벡터 path' : '투명 배경'}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {format === 'png' && (
              <div>
                <div className="mb-2 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">해상도</div>
                <Segmented value={scale} onChange={setScale} options={[{ value: '1', label: '1x' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }]} />
                <div className="mt-1.5 font-mono text-[11px] text-ink-400">{px.w} × {px.h} px</div>
              </div>
            )}
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">색상</div>
              <Segmented value={color} onChange={setColor} options={[{ value: 'original', label: '원본' }, { value: 'black', label: '검정' }, { value: 'white', label: '흰색' }]} />
            </div>
            <div>
              <div className="mb-2 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">파일명</div>
              <div className="rounded-md border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-[11px] break-all text-ink-200">{fileName}</div>
              <div className="mt-1.5 text-[11px] text-ink-400">
                viewBox {result.viewBox} · 노드 {result.nodesAfter.toLocaleString()}개
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={download}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-lime px-4 py-2.5 font-semibold text-ink-950 hover:brightness-110 disabled:opacity-50"
            >
              <Download size={16} /> {busy ? '생성 중…' : '다운로드'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
