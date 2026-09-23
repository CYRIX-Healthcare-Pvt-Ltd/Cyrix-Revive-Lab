import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'

/**
 * A row of choices, each in a colour of its own — chosen or not — so which
 * is which reads before anything is chosen (the user, 18 Sep: "wherever there
 * is an option like this, a separate colour"). The chosen one is filled and
 * ringed in its colour. Whole class names, so Tailwind finds them.
 */
export type ChoiceTone = 'sky' | 'violet' | 'amber' | 'red' | 'green' | 'teal' | 'fuchsia' | 'orange' | 'slate'

const LOOK: Record<ChoiceTone, { on: string; off: string; icon: string }> = {
  sky: { on: 'border-sky-300 bg-sky-50 ring-1 ring-sky-300', off: 'hover:border-sky-300 hover:bg-sky-50/50', icon: 'text-sky-600' },
  violet: { on: 'border-violet-300 bg-violet-50 ring-1 ring-violet-300', off: 'hover:border-violet-300 hover:bg-violet-50/50', icon: 'text-violet-600' },
  amber: { on: 'border-amber-300 bg-amber-50 ring-1 ring-amber-300', off: 'hover:border-amber-300 hover:bg-amber-50/50', icon: 'text-amber-600' },
  red: { on: 'border-cyrixRed-300 bg-cyrixRed-50 ring-1 ring-cyrixRed-300', off: 'hover:border-cyrixRed-300 hover:bg-cyrixRed-50/50', icon: 'text-cyrixRed-600' },
  green: { on: 'border-green-300 bg-green-50 ring-1 ring-green-300', off: 'hover:border-green-300 hover:bg-green-50/50', icon: 'text-green-600' },
  teal: { on: 'border-teal-300 bg-teal-50 ring-1 ring-teal-300', off: 'hover:border-teal-300 hover:bg-teal-50/50', icon: 'text-teal-600' },
  fuchsia: { on: 'border-fuchsia-300 bg-fuchsia-50 ring-1 ring-fuchsia-300', off: 'hover:border-fuchsia-300 hover:bg-fuchsia-50/50', icon: 'text-fuchsia-600' },
  orange: { on: 'border-orange-300 bg-orange-50 ring-1 ring-orange-300', off: 'hover:border-orange-300 hover:bg-orange-50/50', icon: 'text-orange-600' },
  slate: { on: 'border-slate-300 bg-slate-50 ring-1 ring-slate-300', off: 'hover:border-slate-300 hover:bg-slate-50/50', icon: 'text-slate-500' },
}

export interface ChoiceOption<T extends string> {
  value: T
  label: string
  hint?: string
  tone: ChoiceTone
  icon?: LucideIcon
}

export default function Choices<T extends string>({
  label, options, value, onChange, required, disabled, columns = options.length, note,
}: {
  label: string
  options: ReadonlyArray<ChoiceOption<T>>
  value: T | null
  onChange: (next: T) => void
  required?: boolean
  /** Fixed, and said why in the note — a CAMC spare's criticality. */
  disabled?: boolean
  columns?: number
  note?: string
}) {
  return (
    <div role="radiogroup" aria-label={label}>
      <span className="label">{label}{required && <span className="text-cyrixRed-600"> *</span>}</span>
      <div className={clsx('mt-1 grid gap-2', columns >= 3 ? 'grid-cols-3' : 'grid-cols-2')}>
        {options.map(o => {
          const on = value === o.value
          const look = LOOK[o.tone]
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled && !on}
              onClick={() => { if (!disabled) onChange(o.value) }}
              className={clsx(
                'flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                on ? look.on : clsx('border-ink-200', !disabled && look.off),
                disabled && !on && 'cursor-not-allowed opacity-50',
                disabled && on && 'cursor-default',
              )}
            >
              {o.icon && <o.icon className={clsx('h-4 w-4 shrink-0', look.icon)} />}
              <span className="min-w-0">
                <span className={clsx('block text-sm font-medium', on ? 'text-ink-900' : 'text-ink-800')}>{o.label}</span>
                {o.hint && <span className="block truncate text-xs text-ink-500">{o.hint}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {note && <p className="mt-1 text-xs text-ink-500">{note}</p>}
    </div>
  )
}
