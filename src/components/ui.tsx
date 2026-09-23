/**
 * The shared pieces, taken from KPI's components/ui.tsx as they are.
 *
 * Copied rather than re-drawn, so a loader, an alert, an empty state and a
 * stat tile look the same in every module — the platform is meant to read
 * as one product. Only the appraisal-specific pieces (score pills, bands)
 * are left behind; nothing here has been restyled.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, ChevronsUpDown, Info, Loader2, Warehouse } from 'lucide-react'
import { STATUS, TONE_CLASS, statusLook, type Closure, type Proposal, type TicketStatus } from '@/lib/tickets'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin', className ?? 'h-5 w-5')} />
}

/** Five bars, staggered — KPI's loader, in the page accent. */
export function ChartLoader({ className }: { className?: string }) {
  const bars = [0.55, 0.8, 1, 0.65, 0.9]
  return (
    <div
      className={clsx('flex items-end gap-[3px]', className ?? 'h-7')}
      role="status"
      aria-label="Loading"
    >
      {bars.map((h, i) => (
        <span
          key={i}
          className="animate-chart-bar w-[5px] rounded-sm"
          style={{
            height: `${h * 100}%`,
            animationDelay: `${i * 70}ms`,
            backgroundColor: 'var(--score-accent)',
          }}
        />
      ))}
    </div>
  )
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-ink-500">
      <ChartLoader />
      <p className="text-sm">{label}</p>
    </div>
  )
}

export function Alert({
  kind = 'info',
  title,
  children,
}: {
  kind?: 'info' | 'error' | 'success' | 'warning'
  title?: string
  children?: ReactNode
}) {
  // An error comes to you, then stays pinned under the header while you
  // are on the page — the message and the button that failed, together.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (kind !== 'error' && kind !== 'warning') return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [kind])

  const styles = {
    info: 'bg-ink-50 border-ink-200 text-ink-800',
    error: 'bg-cyrixRed-50 border-cyrixRed-200 text-cyrixRed-900',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
  }[kind]
  const Icon = { info: Info, error: AlertCircle, success: CheckCircle2, warning: AlertCircle }[kind]

  return (
    <div
      ref={ref}
      role={kind === 'error' ? 'alert' : undefined}
      className={clsx(
        'flex gap-3 rounded-lg border p-3.5 text-sm',
        styles,
        kind === 'error' && 'sticky top-16 z-20 shadow-lg',
      )}
    >
      <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-1')}>{children}</div>}
      </div>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: string
  children?: ReactNode
}) {
  return (
    <div className="card flex flex-col items-center gap-3 p-10 text-center">
      {Icon && <Icon className="h-9 w-9 text-ink-300" />}
      <p className="font-medium text-ink-700">{title}</p>
      {children && <div className="max-w-md text-sm text-ink-500">{children}</div>}
    </div>
  )
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  sub?: string
  tone?: 'default' | 'brand'
}) {
  return (
    <div
      className={clsx(
        'card flex flex-col p-4',
        tone === 'brand' && 'border-ink-300 bg-ink-50',
      )}
    >
      <p className="label !mb-0">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-ink-900">{value}</p>
      <p className="mt-0.5 min-h-4 text-xs text-ink-400">{sub}</p>
    </div>
  )
}

/** A column heading that sorts its table — KPI’s, with its mark always showing. */
export function SortHeader<K extends string>({
  label, col, align = 'left', sortKey, asc, onSort, className,
}: {
  label: string
  col: K
  align?: 'left' | 'right'
  sortKey: K | null
  asc: boolean
  onSort: (key: K) => void
  className?: string
}) {
  const active = sortKey === col
  return (
    <th
      className={clsx('px-4 py-2.5 font-medium', align === 'right' && 'text-right', className)}
      aria-sort={active ? (asc ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={clsx(
          'group inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wide hover:text-ink-900',
          active ? 'text-ink-900' : 'text-ink-500',
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {/* Unlike KPI's copy, a heading that sorts says so before it is
            clicked: asked "how to sort?", the answer should be on screen. */}
        {active
          ? (asc ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)
          : <ChevronsUpDown aria-hidden className="h-3 w-3 shrink-0 text-ink-300 group-hover:text-ink-500" />}
      </button>
    </th>
  )
}

/**
 * A spare from a warehouse rather than a hospital (rl_0020), marked wherever
 * the ticket shows — dark on light and light on dark, so it never reads as
 * one of the status colours.
 */
/**
 * Whose equipment it is, after the hospital's name: Pvt — the private
 * contract, whose customer can be billed — or Govt, every government
 * programme (KL, AP, RJ, UP …). The user, 23 Sep: "DH Kannur - Pvt; except
 * Pvt it should be Govt". A warehouse's spare has neither; it says Warehouse.
 */
export function SectorTag({ ticket: t, className }: {
  ticket: { source?: string | null; bemmp_code?: string | null; asks_billing_estimate?: boolean | null }
  className?: string
}) {
  if (t.source === 'warehouse' || !t.bemmp_code) return null
  // The private BEMMP is the one that asks for a billing estimate; by its code until the list says (rl_0025).
  const pvt = t.asks_billing_estimate ?? t.bemmp_code.toLowerCase() === 'pvt'
  return (
    <span
      className={clsx(
        'inline-block whitespace-nowrap rounded px-1.5 py-px align-middle text-[10px] font-semibold',
        pvt ? 'bg-fuchsia-100 text-fuchsia-900' : 'bg-ink-100 text-ink-700',
        className,
      )}
      title={`BEMMP ${t.bemmp_code}`}
    >
      {pvt ? 'Pvt' : 'Govt'}
    </span>
  )
}

export function WarehouseChip({ className }: { className?: string }) {
  return (
    <span className={clsx('badge inline-flex items-center gap-1 whitespace-nowrap bg-ink-800 text-ink-50', className)}>
      <Warehouse aria-hidden className="h-3 w-3" /> Warehouse
    </span>
  )
}

/** A ticket's status, in the colour of where it is in the journey. */
/** A closed ticket that did not come back says so: Scrapped, Discarded. */
export function StatusBadge({ status, closure, proposal, full = false }: {
  status: TicketStatus
  closure?: Closure | null
  proposal?: Proposal | null
  full?: boolean
}) {
  if (!STATUS[status]) return <span className="badge bg-ink-100 text-ink-700">{status}</span>
  const look = statusLook(status, closure, proposal)
  return (
    <span className={clsx('badge whitespace-nowrap', TONE_CLASS[look.tone])}>
      {full ? look.label : look.short}
    </span>
  )
}
