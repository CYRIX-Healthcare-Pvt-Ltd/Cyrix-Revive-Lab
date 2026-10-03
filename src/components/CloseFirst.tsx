import { Link } from 'react-router-dom'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import Dialog from '@/components/Dialog'
import IconChip from '@/components/IconChip'
import { StatusBadge } from '@/components/ui'
import { dayDate } from '@/lib/when'
import type { OverdueReturn } from '@/lib/queries'

/** "2026-09-24" as that day here, not as midnight in London. */
const onDay = (d: string) => { const [y, m, day] = d.split('-').map(Number); return new Date(y, m - 1, day) }

/**
 * Why a field engineer cannot raise a ticket now, and the way out (rl_0041).
 *
 * The spares that came back to them and have waited past the days set for
 * their state: in transit back, with nobody saying it arrived; or received
 * back, and not closed as working or not. Closing is where the field
 * engineer says whether the spare works (the user, 3 Oct: "engineers are not
 * closing tickets, and if not working they will blame trc engineer").
 *
 * Each opens its ticket, where Received back and Close ticket are (the user:
 * "they should be able to click on the ticket and redirect to our closing
 * ticket"), and the ticket's back link comes back here, so the next one is a
 * press away — and once none is left, the route card.
 */
export default function CloseFirst({ tickets, onClose }: { tickets: OverdueReturn[]; onClose: () => void }) {
  const one = tickets.length === 1
  return (
    <Dialog title="Close these tickets first" icon={<IconChip icon={TriangleAlert} tone="red" />} onClose={onClose} wide>
      <p className="text-sm text-ink-600">
        {one ? 'A spare that came back to you is' : `${tickets.length} spares that came back to you are`} still open, past the days allowed.
        {' '}Close {one ? 'it' : 'them'} first, then you can raise a new ticket.
      </p>
      <ul className="space-y-2">
        {tickets.map(t => {
          const back = t.status === 'received_back'
          return (
            <li key={t.id}>
              <Link
                to={`/tickets/${t.code}`}
                state={{ back: { to: '/new', label: 'Raise a ticket' } }}
                className="btn-press flex items-center gap-3 rounded-xl border border-ink-200 bg-surface p-3 transition-colors hover:border-ink-300 hover:bg-ink-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-ink-900">{t.code}</span>
                    <StatusBadge status={t.status} />
                  </span>
                  <span className="mt-1 block truncate text-sm text-ink-700">
                    {t.facility}{t.spare_name ? ` · ${t.spare_name}` : ''}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-500">
                    {back
                      ? <>Received on {dayDate(onDay(t.since))} · press <span className="font-medium text-ink-700">Close ticket</span> within {t.limit_days} days</>
                      : <>Dispatched on {dayDate(onDay(t.since))} · press <span className="font-medium text-ink-700">Received back</span> within {t.limit_days} days</>}
                  </span>
                </span>
                {/* How long, against how long was allowed: the number that has to come down. */}
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                  <span className="rounded-full bg-cyrixRed-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-cyrixRed-900">
                    {t.days} days
                  </span>
                  <span className="text-[11px] tabular-nums text-ink-500">{t.days - t.limit_days} over</span>
                </span>
                <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-ink-300" />
              </Link>
            </li>
          )
        })}
      </ul>
      <button type="button" className="btn-secondary w-full justify-center" onClick={onClose}>Back</button>
    </Dialog>
  )
}
