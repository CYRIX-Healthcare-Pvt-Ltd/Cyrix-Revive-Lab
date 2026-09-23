import clsx from 'clsx'
import { AlarmClock, Hourglass, Shield, ShieldAlert } from 'lucide-react'
import Choices, { type ChoiceOption } from '@/components/Choices'
import {
  CATEGORY_TAT_DAYS, CRITICALITY_LABEL, SPARE_CATEGORIES, type Criticality, type SpareCategory,
} from '@/lib/tickets'
import { categoryTat, formatSpan, type CategoryTat } from '@/lib/tat'
import { dateTime } from '@/lib/when'

/**
 * A spare's category and criticality (rl_0024): what the Revive Lab says it
 * is on arrival, and changes until it is dispatched back. The category sets
 * how long the Revive Lab may keep it — A 3 days, B 2, C 1 — from acceptance.
 */

const CATEGORY_TONE = { A: 'sky', B: 'violet', C: 'amber' } as const

export const CATEGORY_CHOICES: ReadonlyArray<ChoiceOption<SpareCategory>> = SPARE_CATEGORIES.map(c => ({
  value: c,
  label: c,
  hint: `TAT ${CATEGORY_TAT_DAYS[c]} day${CATEGORY_TAT_DAYS[c] === 1 ? '' : 's'}`,
  tone: CATEGORY_TONE[c],
}))

export const CRITICALITY_CHOICES: ReadonlyArray<ChoiceOption<Criticality>> = [
  { value: 'critical', label: CRITICALITY_LABEL.critical, tone: 'red', icon: ShieldAlert },
  { value: 'non_critical', label: CRITICALITY_LABEL.non_critical, tone: 'green', icon: Shield },
]

/** The two questions, side by side; a CAMC spare's criticality is fixed. */
export function ClassificationFields({ category, criticality, onCategory, onCriticality, camc }: {
  category: SpareCategory | null
  criticality: Criticality | null
  onCategory: (c: SpareCategory) => void
  onCriticality: (c: Criticality) => void
  camc: boolean
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
      <Choices label="Spare category" options={CATEGORY_CHOICES} value={category} onChange={onCategory} required />
      <Choices
        label="Spare criticality"
        options={CRITICALITY_CHOICES}
        value={camc ? 'critical' : criticality}
        onChange={onCriticality}
        required
        disabled={camc}
        note={camc ? 'A CAMC spare is always critical.' : undefined}
      />
    </div>
  )
}

const CHIP = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium'

/**
 * Where the spare stands against its category's TAT: due when, and how long
 * is left; within it; or exceeded, and by how much.
 */
export function TatChip({ tat }: { tat: CategoryTat }) {
  if (tat.exceeded) {
    return (
      <span className={clsx(CHIP, 'bg-cyrixRed-100 text-cyrixRed-900')}>
        <AlarmClock aria-hidden className="h-3.5 w-3.5" />
        TAT exceeded by {formatSpan(tat.overMs)}{tat.endedAt !== null ? ' at dispatch' : ''}
      </span>
    )
  }
  if (tat.endedAt !== null) {
    return (
      <span className={clsx(CHIP, 'bg-green-100 text-green-900')}>
        <Hourglass aria-hidden className="h-3.5 w-3.5" /> Within TAT
      </span>
    )
  }
  return (
    <span className={clsx(CHIP, 'bg-sky-100 text-sky-900')}>
      <Hourglass aria-hidden className="h-3.5 w-3.5" />
      TAT due {dateTime(tat.dueAt, false)} · {formatSpan(-tat.overMs)} left
    </span>
  )
}

/** Each category in the colour of its choice button, so a row reads like the form it came from. */
export const CATEGORY_CLASS: Record<SpareCategory, string> = {
  A: 'bg-sky-100 text-sky-900',
  B: 'bg-violet-100 text-violet-900',
  C: 'bg-amber-100 text-amber-900',
}

/**
 * For a row in a list: the category and the criticality, both, on every
 * ticket that has them (the user, 23 Sep: "against each ticket it should show
 * category and type"), and "TAT exceeded" in red when it is — the one thing
 * a list must not hide.
 */
export function ClassTag({ ticket: t, className, oneLine = false }: {
  ticket: {
    spare_category: SpareCategory | null
    criticality: Criticality | null
    accepted_at: string | null
    dispatched_at: string | null
    scrapped_at: string | null
  }
  className?: string
  /** In a table cell: all on one line, the table scrolls rather than the row growing. */
  oneLine?: boolean
}) {
  const tat = categoryTat(t)
  if (!t.spare_category && !t.criticality) return null
  return (
    <span className={clsx('inline-flex items-center gap-1', oneLine ? 'flex-nowrap whitespace-nowrap' : 'flex-wrap', className)}>
      {t.spare_category && (
        // The letter alone, in its own square — "Cat A" read as old (the user, 23 Sep); the word stays for a hover and a screen reader.
        <span
          className={clsx('inline-block min-w-5 rounded px-1 py-px text-center text-[10px] font-bold', CATEGORY_CLASS[t.spare_category])}
          title={`Category ${t.spare_category} — ${CATEGORY_TAT_DAYS[t.spare_category]}-day TAT`}
          aria-label={`Category ${t.spare_category}`}
        >
          {t.spare_category}
        </span>
      )}
      {t.criticality && (
        <span className={clsx(
          'rounded px-1.5 py-px text-[10px] font-semibold',
          t.criticality === 'critical' ? 'bg-cyrixRed-100 text-cyrixRed-900' : 'bg-green-100 text-green-900',
        )}>
          {CRITICALITY_LABEL[t.criticality]}
        </span>
      )}
      {tat?.exceeded && (
        <span className="inline-flex items-center gap-0.5 rounded bg-cyrixRed-600 px-1.5 py-px text-[10px] font-semibold text-white">
          <AlarmClock aria-hidden className="h-2.5 w-2.5" /> TAT exceeded
        </span>
      )}
    </span>
  )
}
