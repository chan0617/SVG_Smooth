import { useId, useState } from 'react'

interface Props {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  defaultValue?: number
  hint?: string
  onChange: (v: number) => void
}

/** 슬라이더 + 숫자 입력(오른쪽). 둘은 항상 같은 값을 보여준다. */
export function SliderField({ label, value, min = 0, max = 100, step = 1, defaultValue, hint, onChange }: Props) {
  const id = useId()
  // 숫자 입력은 타이핑 중에만 임시 문자열(draft)을 쓰고, 확정(blur/Enter) 시 범위로 고정
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const setText = setDraft
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  const commit = (raw: string) => {
    const n = Number(raw)
    setDraft(null)
    if (raw.trim() === '' || !Number.isFinite(n)) return
    const v = clamp(n)
    if (v !== value) onChange(v)
  }
  const fill = ((value - min) / (max - min)) * 100
  return (
    <div className="group py-1.5" title={hint}>
      <div className="mb-1 flex items-center justify-between">
        <label htmlFor={id} className="text-ink-200" onDoubleClick={() => defaultValue != null && onChange(defaultValue)}>
          {label}
        </label>
        {value === 0 && min === 0 && <span className="text-[10px] text-ink-500">효과 없음</span>}
      </div>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          className="vs-range"
          min={min}
          max={max}
          step={step}
          value={value}
          style={{ ['--fill' as string]: `${fill}%` }}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          className="vs-num w-14 shrink-0 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-right font-mono text-xs tabular-nums text-ink-100 outline-none focus:border-lime"
          min={min}
          max={max}
          step={step}
          value={text}
          aria-label={`${label} 값`}
          onChange={(e) => {
            setText(e.target.value)
            const n = Number(e.target.value)
            // 범위 안의 완성된 숫자는 즉시 반영(실시간 동기화)
            if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(clamp(n))
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
              onChange(clamp(value + d))
            }
          }}
        />
      </div>
    </div>
  )
}
