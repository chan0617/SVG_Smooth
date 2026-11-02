import type { ReactNode } from 'react'

export function Section({ title, icon, children, right }: { title: string; icon?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-ink-800 px-4 py-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-ink-300 uppercase">
          {icon}
          {title}
        </h2>
        {right}
      </header>
      {children}
    </section>
  )
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5" title={hint}>
      <span className="text-ink-200">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${checked ? 'bg-lime' : 'bg-ink-600'}`}
      >
        <span className={`absolute top-[3px] h-3 w-3 rounded-full transition-all ${checked ? 'left-[17px] bg-ink-950' : 'left-[3px] bg-ink-200'}`} />
      </button>
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-md border border-ink-700 bg-ink-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1 rounded-[5px] font-medium transition-colors ${size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'} ${
            value === o.value ? 'bg-ink-700 text-lime' : 'text-ink-300 hover:text-ink-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function IconButton({ children, onClick, title, disabled, active, className = '' }: { children: ReactNode; onClick?: () => void; title: string; disabled?: boolean; active?: boolean; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-ink-200 transition-colors hover:bg-ink-700 hover:text-ink-100 disabled:pointer-events-none disabled:opacity-35 ${active ? 'bg-ink-700 text-lime' : ''} ${className}`}
    >
      {children}
    </button>
  )
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-lime' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-red-400' : 'text-ink-100'
  return (
    <div className="rounded-md border border-ink-800 bg-ink-900 px-3 py-2">
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className={`font-mono text-[15px] font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-400">{sub}</div>}
    </div>
  )
}
