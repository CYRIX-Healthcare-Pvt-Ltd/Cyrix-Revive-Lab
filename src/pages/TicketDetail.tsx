import { useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  ArrowLeft, ArrowRightLeft, CheckCircle2, ClipboardCheck, ClipboardList, Hand, History as HistoryIcon,
  PackageCheck, PackagePlus, PlayCircle, ScanSearch, Send, Timer, Truck, Undo2, UserCog, UserPlus, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useAccept, useAddObservation, useAssign, useCompleteRepair, useDispatch, useHops, useMarkReceived,
  useMembers, useReturnToDesk, useStartRepair, useTickets, useTrail, useTransfer, useTrcs,
  type Ticket, type TrailEvent,
} from '@/lib/queries'
import {
  actionsFor, parseTicketCode, STATUS, TONE_SOFT, TONE_TEXT, TRC_KIND_LABEL, type Action, type Tone,
} from '@/lib/tickets'
import { formatSpan, ticketTat, type Span } from '@/lib/tat'
import { Alert, EmptyState, PageLoader, Spinner, StatusBadge } from '@/components/ui'
import IconChip from '@/components/IconChip'
import AttachmentsCard from '@/components/TicketAttachments'
import { removeVideoOf } from '@/lib/attachments'

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }) : '—'

const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

export default function TicketDetail() {
  const { code } = useParams()
  const number = parseTicketCode(code)
  const { data: tickets, isLoading } = useTickets()
  const ticket = (tickets ?? []).find(t => t.number === number)

  if (isLoading) return <PageLoader />
  if (!ticket) {
    return (
      <div className="space-y-4">
        <BackLink />
        <EmptyState icon={Wrench} title={`${code} is not a ticket you can see`}>
          It may not exist, or it may belong to a Revive Lab and a team you are not part of.
        </EmptyState>
      </div>
    )
  }
  return <TicketView ticket={ticket} />
}

function BackLink() {
  return (
    <Link to="/tickets" className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
      <ArrowLeft className="h-4 w-4" /> All tickets
    </Link>
  )
}

function TicketView({ ticket: t }: { ticket: Ticket }) {
  const { me } = useAuth()
  // Set by the raise screen when a photo or the voice note did not upload.
  const uploadFailed = (useLocation().state as { uploadFailed?: string[] } | null)?.uploadFailed
  const { data: trail } = useTrail(t.id)
  const { data: hops } = useHops(t.id)

  const actions = actionsFor(t, me)
  const tat = useMemo(() => ticketTat((trail ?? []).filter(e => e.kind !== 'observation'), t.trc_id), [trail, t.trc_id])
  const meta = STATUS[t.status]
  const trcName = (id: string | null) => trail?.find(e => e.trc_id === id)?.trc_name
    ?? hops?.find(h => h.to_trc_id === id)?.to_trc_name ?? (id === t.trc_id ? t.trc_name : '—')

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold text-ink-900">{t.code}</h1>
              <StatusBadge status={t.status} full />
            </div>
            <p className="mt-1 text-sm text-ink-600">
              {t.facility}{t.spare_name ? ` · ${t.spare_name}` : ''}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">
              At {t.trc_name}
              {!t.trc_name.toLowerCase().includes(TRC_KIND_LABEL[t.trc_kind].toLowerCase()) && (
                <> ({TRC_KIND_LABEL[t.trc_kind]})</>
              )}
              {t.status !== 'closed' && <> · waiting on {meta.waitingOn}</>}
            </p>
          </div>
          {/* Right-aligned beside the title; on a phone it drops below it, and lines up on the left. */}
          <div className="sm:text-right">
            <p className="label !mb-0">{t.status === 'closed' ? 'Total TAT' : 'Open for'}</p>
            <p className="text-2xl font-semibold tabular-nums text-ink-900">{formatSpan(tat.total.ms)}</p>
          </div>
        </div>

        {actions.length > 0 && (
          <div className="border-t border-ink-200 bg-ink-50 p-4 sm:px-5">
            <ActionBar ticket={t} actions={actions} />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <TatCard tat={tat} trcName={trcName} />

          {uploadFailed && uploadFailed.length > 0 && (
            <Alert kind="warning" title="The ticket was raised, but not everything was sent">
              {uploadFailed.join(' and ')} did not upload. Add {uploadFailed.length === 1 ? 'it' : 'them'} again below.
            </Alert>
          )}

          {/* The route card, in the card's own order. */}
          <Section title="Service route card" icon={ClipboardList} tone="sky">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row label="State">{t.state}</Row>
              <Row label="District">{t.district}</Row>
              <Row label="BEMMP">{t.bemmp_code}</Row>
              <Row label="Hospital name">{t.facility}</Row>
              <Row label="Equipment barcode">{t.equipment_barcode && <span className="font-mono">{t.equipment_barcode}</span>}</Row>
              <Row label="Equipment name">{t.equipment_name}</Row>
              <Row label="Spare name">{t.spare_name}</Row>
              <Row label="Ticket ID">{t.source_ticket_no && <span className="font-mono">{t.source_ticket_no}</span>}</Row>
              {/* With their function, so the Revive Lab can see which part of
                  the business a spare is coming from without asking. */}
              <Row label="Sent by">
                {t.raised_by_name}
                {t.raised_by_function && <span className="text-xs text-ink-500"> · {t.raised_by_function}</span>}
                <span className="text-xs text-ink-400"> · {t.raised_as === 'coordinator' ? 'at the Revive Lab' : 'from the field'}</span>
              </Row>
              <Row label="Contact number">
                {t.contact_number && <a href={'tel:' + t.contact_number} className="link-accent">{t.contact_number}</a>}
              </Row>
              <Row label="Field engineer">
                {t.stakeholder_name} <span className="text-xs text-ink-400">{t.stakeholder_ecode}</span>
                {t.stakeholder_function && <span className="text-xs text-ink-500"> · {t.stakeholder_function}</span>}
              </Row>
              <Row label="Their manager">{t.stakeholder_manager_name}</Row>
              <Row label="Revive Lab engineer">
                {t.engineer_name && <>{t.engineer_name} <span className="text-xs text-ink-400">{t.engineer_ecode}</span></>}
              </Row>
            </dl>
          </Section>

          <AttachmentsCard ticket={t} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Section title="Courier details" icon={Truck} tone="teal">
              <Courier name={t.in_courier} awb={t.in_awb} on={t.in_dispatched_on} empty="Not recorded" />
            </Section>
            {/* The same truck, facing home. */}
            <Section title="Return courier" icon={Truck} tone="green" iconClassName="-scale-x-100">
              <div className="space-y-3">
                <Row label="Spare return address">
                  {t.return_address && <span className="whitespace-pre-wrap">{t.return_address}</span>}
                </Row>
                <Courier name={t.out_courier} awb={t.out_awb} on={t.out_dispatched_on} empty="Not dispatched yet" />
              </div>
            </Section>
          </div>

          {(hops ?? []).length > 0 && (
            <Section title="Transfers" icon={ArrowRightLeft} tone="violet">
              <ol className="space-y-3">
                {hops!.map(h => (
                  <li key={h.hop} className="rounded-lg border border-ink-200 p-3">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink-900">
                      <ArrowRightLeft className="h-4 w-4 text-violet-600" />
                      {h.from_trc_name} → {h.to_trc_name}
                      <span className="text-xs font-normal text-ink-400">· hop {h.hop} · {when(h.transferred_at)}</span>
                    </p>
                    {h.reason && <p className="mt-1 text-sm text-ink-600">{h.reason}</p>}
                    <p className="mt-1 text-xs text-ink-500">
                      {[h.courier, h.awb && `AWB ${h.awb}`, day(h.dispatched_on) && `sent ${day(h.dispatched_on)}`, h.transferred_by_name && `by ${h.transferred_by_name}`]
                        .filter(Boolean).join(' · ') || 'No courier recorded'}
                    </p>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </div>

        <Section title="History" icon={HistoryIcon} tone="indigo">
          {!trail ? <Spinner className="h-4 w-4 text-ink-400" /> : <Timeline trail={trail} />}
        </Section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Section({
  title, icon, tone, iconClassName, children,
}: {
  title: string
  icon: LucideIcon
  tone: Tone
  iconClassName?: string
  children: ReactNode
}) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-ink-200 bg-ink-50 px-4 py-2">
        <IconChip icon={icon} tone={tone} iconClassName={iconClassName} />
        <h3 className="text-sm font-semibold text-ink-800">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === ''
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-label text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink-900">{empty ? <span className="text-ink-300">—</span> : children}</dd>
    </div>
  )
}

function Courier({ name, awb, on, empty }: { name: string | null; awb: string | null; on: string | null; empty: string }) {
  if (!name && !awb && !on) return <p className="text-sm text-ink-400">{empty}</p>
  return (
    <dl className="space-y-2">
      <Row label="Courier">{name}</Row>
      <Row label="Tracking / AWB">{awb && <span className="font-mono">{awb}</span>}</Row>
      <Row label="Dispatched">{day(on)}</Row>
    </dl>
  )
}

/* ------------------------------------------------------------------ */

/**
 * What a step in the history is called, and how it looks.
 *
 * Each step takes the colour of the status it moved the ticket to — the
 * same colour as the badge at the top — and the icon of the button that
 * made it, so the history reads as the buttons that were pressed.
 */
function stepLook(e: TrailEvent, earlier: TrailEvent[]): { title: ReactNode; tone: Tone; icon: LucideIcon } {
  const tone = STATUS[e.status]?.tone ?? 'sky'
  if (e.kind === 'observation') {
    // Numbered, so "Observation 2" can be talked about on the phone.
    const n = earlier.filter(x => x.kind === 'observation').length + 1
    return { title: `Observation ${n}`, tone, icon: ScanSearch }
  }
  if (e.from_status === null) return { title: 'Raised', tone, icon: PackagePlus }

  switch (e.status) {
    case 'accepted':
      return e.from_status !== 'pending_acceptance' && e.from_status !== 'transferred'
        ? { title: 'Handed back to the coordinator', tone, icon: Undo2 }
        : { title: STATUS.accepted.label, tone, icon: Hand }
    case 'assigned': {
      // Any earlier assignment makes this one a reassignment — straight from
      // one engineer to another, or again after being handed back.
      const again = earlier.some(x => x.status === 'assigned')
      const title = e.engineer_name
        ? <>{again ? 'Reassigned' : 'Assigned'} to {e.engineer_name}
          {e.engineer_ecode && <span className="font-normal text-ink-400"> {e.engineer_ecode}</span>}</>
        : again ? 'Reassigned to another engineer' : STATUS.assigned.label
      return { title, tone, icon: again ? UserCog : UserPlus }
    }
    case 'in_repair': return { title: STATUS.in_repair.label, tone, icon: Wrench }
    case 'repaired': return { title: STATUS.repaired.label, tone, icon: ClipboardCheck }
    case 'in_transit_return': return { title: STATUS.in_transit_return.label, tone, icon: Send }
    case 'closed': return { title: STATUS.closed.label, tone, icon: PackageCheck }
    case 'transferred': return { title: STATUS.transferred.label, tone, icon: ArrowRightLeft }
    default: return { title: STATUS[e.status]?.label ?? e.status, tone, icon: PackagePlus }
  }
}

function Timeline({ trail }: { trail: TrailEvent[] }) {
  return (
    <ol>
      {trail.map((e, i) => {
        const look = stepLook(e, trail.slice(0, i))
        const last = i === trail.length - 1
        return (
          <li key={e.id} className={clsx('relative flex gap-3', !last && 'pb-5')}>
            {/* The thread from this step down to the next. */}
            {!last && <span aria-hidden className="absolute bottom-0 left-4 top-8 w-px -translate-x-1/2 bg-ink-200" />}
            <span className={clsx('relative grid h-8 w-8 shrink-0 place-items-center rounded-full', TONE_SOFT[look.tone])}>
              <look.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-sm font-medium text-ink-900">{look.title}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {when(e.at)} · {e.actor_name ?? 'System'}{e.trc_name ? ` · ${e.trc_name}` : ''}
              </p>
              {e.note && (
                <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-ink-50 px-2.5 py-1.5 text-sm text-ink-700">{e.note}</p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ------------------------------------------------------------------ */

function SpanCell({ span, label }: { span: Span; label: string }) {
  return (
    <div className="rounded-lg border border-ink-200 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">{label}</p>
      <p className={clsx('mt-1 text-lg font-semibold tabular-nums', span.ms === null ? 'text-ink-300' : 'text-ink-900')}>
        {formatSpan(span.ms)}
      </p>
      <p className="min-h-4 text-xs text-ink-400">{span.running ? 'still going' : ''}</p>
    </div>
  )
}

/**
 * The stages, and — when the spare changed Revive Labs — each Revive Lab's share.
 *
 * Measured from the history beside it, so the two cannot disagree: every
 * figure here is the gap between two of those timestamps. The whole of it
 * is the "Open for" at the top of the page, so it is not said again here.
 */
function TatCard({
  tat, trcName,
}: {
  tat: ReturnType<typeof ticketTat>
  trcName: (id: string | null) => string
}) {
  return (
    <Section title="Turnaround" icon={Timer} tone="indigo">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SpanCell label="Reach Revive Lab" span={tat.reach} />
        <SpanCell label="To assignment" span={tat.assign} />
        <SpanCell label="Repair" span={tat.repair} />
        <SpanCell label="Dispatch & transit" span={tat.dispatch} />
      </div>

      {tat.legs.length > 1 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
                <th className="py-2 pr-3 font-medium">Revive Lab leg</th>
                <th className="px-3 py-2 text-right font-medium">Reach</th>
                <th className="px-3 py-2 text-right font-medium">Assign</th>
                <th className="px-3 py-2 text-right font-medium">Repair</th>
                <th className="px-3 py-2 text-right font-medium">Dispatch</th>
                <th className="py-2 pl-3 text-right font-medium">At this Revive Lab</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {tat.legs.map((leg, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3 text-ink-900">
                    {i + 1}. {trcName(leg.trcId)}
                    <span className="block text-xs text-ink-400">
                      {leg.endedBy === 'transfer' ? 'transferred on' : leg.endedBy === 'closed' ? 'closed' : 'current'}
                    </span>
                  </td>
                  {[leg.reach, leg.assign, leg.repair, leg.dispatch, leg.total].map((s, j) => (
                    <td key={j} className={clsx('px-3 py-2 text-right tabular-nums', s.ms === null ? 'text-ink-300' : 'text-ink-700', j === 4 && 'pl-3 pr-0 font-medium')}>
                      {formatSpan(s.ms)}{s.running && s.ms !== null ? '…' : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-ink-200 font-medium">
                <td className="py-2 pr-3 text-ink-900">Cumulative</td>
                {[tat.reach, tat.assign, tat.repair, tat.dispatch, tat.total].map((s, j) => (
                  <td key={j} className="px-3 py-2 text-right tabular-nums text-ink-900 last:pr-0">{formatSpan(s.ms)}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Section>
  )
}

/* ------------------------------------------------------------------ */

/** Each move in the colour of the status it leads to — the colour its step takes in the history. */
const ACTION_META: Record<Action, { label: string; icon: LucideIcon; tone: Tone; primary?: boolean }> = {
  accept: { label: 'Accept', icon: Hand, tone: 'amber', primary: true },
  assign: { label: 'Assign engineer', icon: UserPlus, tone: 'sky', primary: true },
  start: { label: 'Accept repair', icon: PlayCircle, tone: 'indigo', primary: true },
  complete: { label: 'Close repair', icon: ClipboardCheck, tone: 'lime', primary: true },
  observe: { label: 'Add observation', icon: ScanSearch, tone: 'indigo' },
  dispatch: { label: 'Dispatch back', icon: Send, tone: 'teal', primary: true },
  received: { label: 'Received back', icon: PackageCheck, tone: 'green', primary: true },
  return: { label: 'Hand back to coordinator', icon: Undo2, tone: 'amber' },
  transfer: { label: 'Transfer to another Revive Lab', icon: ArrowRightLeft, tone: 'violet' },
}

/** Once an engineer has it, the same button gives it to somebody else. */
function actionMeta(action: Action, t: Ticket) {
  const m = ACTION_META[action]
  return action === 'assign' && t.engineer_id ? { ...m, label: 'Reassign engineer', icon: UserCog } : m
}

/**
 * The moves this person can make, and the one form each needs.
 *
 * One form open at a time, under the buttons — the question and the answer
 * together — and every move asks only for what that move records.
 */
function ActionBar({ ticket: t, actions }: { ticket: Ticket; actions: Action[] }) {
  const [open, setOpen] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  return (
    <div className="space-y-3">
      {error && <Alert kind="error">{error}</Alert>}
      {done && <Alert kind="success">{done}</Alert>}
      <div className="flex flex-wrap gap-2">
        {actions.map(a => {
          const m = actionMeta(a, t)
          return (
            <button
              key={a}
              type="button"
              onClick={() => { setOpen(open === a ? null : a); setError(null); setDone(null) }}
              className={clsx(m.primary ? 'btn-primary' : 'btn-secondary', open === a && 'ring-2 ring-offset-1 ring-ink-400')}
              aria-expanded={open === a}
            >
              <m.icon className={clsx('h-4 w-4', TONE_TEXT[m.tone])} /> {m.label}
            </button>
          )
        })}
      </div>
      {open && (
        <ActionForm
          key={open}
          ticket={t}
          action={open}
          onCancel={() => setOpen(null)}
          onError={setError}
          onDone={msg => { setOpen(null); setError(null); setDone(msg) }}
        />
      )}
    </div>
  )
}

function ActionForm({
  ticket: t, action, onCancel, onError, onDone,
}: {
  ticket: Ticket
  action: Action
  onCancel: () => void
  onError: (msg: string) => void
  onDone: (msg: string) => void
}) {
  const { data: members } = useMembers()
  const { data: trcs } = useTrcs()
  const accept = useAccept()
  const assign = useAssign()
  const start = useStartRepair()
  const observe = useAddObservation()
  const giveBack = useReturnToDesk()
  const complete = useCompleteRepair()
  const dispatch = useDispatch()
  const received = useMarkReceived()
  const transfer = useTransfer()

  const meta = actionMeta(action, t)
  // Reassigning: somebody has it, and the choice is who has it instead.
  const reassign = action === 'assign' && !!t.engineer_id

  const [note, setNote] = useState('')
  const [engineerId, setEngineerId] = useState(reassign ? '' : t.engineer_id ?? '')
  const [toTrc, setToTrc] = useState('')
  const [courier, setCourier] = useState('')
  const [awb, setAwb] = useState('')
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10))

  const engineers = (members ?? [])
    .filter(m => m.is_engineer && m.trc_ids.includes(t.trc_id) && m.employee_id !== t.engineer_id)
  // Regional first: an unrepairable spare usually goes up a level.
  const destinations = (trcs ?? [])
    .filter(x => x.is_active && x.id !== t.trc_id)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'regional' ? -1 : 1))

  const busy = [accept, assign, start, observe, giveBack, complete, dispatch, received, transfer].some(m => m.isPending)

  const run = async () => {
    try {
      switch (action) {
        case 'accept':
          await accept.mutateAsync({ id: t.id, note }); onDone(`${t.code} accepted at ${t.trc_name}.`); break
        case 'assign': {
          if (!engineerId) { onError('Choose the engineer.'); return }
          await assign.mutateAsync({ id: t.id, engineerId, note })
          const who = engineers.find(e => e.employee_id === engineerId)?.full_name
          onDone(`${reassign ? 'Reassigned' : 'Assigned'} to ${who ?? 'the engineer'}. They accept it before starting.`); break
        }
        case 'start':
          await start.mutateAsync({ id: t.id, note }); onDone('Repair accepted — repair time is counting from now.'); break
        case 'observe':
          if (note.trim().length < 3) { onError('Write what was found.'); return }
          await observe.mutateAsync({ id: t.id, note }); onDone('Observation added to the history. Add another whenever there is more.'); break
        case 'return':
          await giveBack.mutateAsync({ id: t.id, note }); onDone('Handed back to the coordinator.'); break
        case 'complete':
          if (note.trim().length < 3) { onError('Say what action was taken on it.'); return }
          await complete.mutateAsync({ id: t.id, note }); onDone('Repair closed. It is with the coordinator for dispatch.'); break
        case 'dispatch':
          await dispatch.mutateAsync({ id: t.id, courier, awb, on, note }); onDone('Dispatched back to the field.'); break
        case 'received':
          if (note.trim().length < 2) { onError('Give the final status — is it working?'); return }
          await received.mutateAsync({ id: t.id, note }); void removeVideoOf(t.id); onDone(`${t.code} is closed.`); break
        case 'transfer': {
          if (!toTrc) { onError('Choose the Revive Lab it is going to.'); return }
          await transfer.mutateAsync({ id: t.id, toTrcId: toTrc, reason: note, courier, awb, on })
          onDone(`Transferred to ${trcs?.find(x => x.id === toTrc)?.name}. Their coordinators accept it on arrival.`); break
        }
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  // The back of the route card: the Revive Lab's Action taken, and the
  // field engineer's Final status.
  const needsNote = action === 'return' || action === 'transfer' || action === 'complete' || action === 'received' || action === 'observe'
  const needsCourier = action === 'dispatch' || action === 'transfer'

  return (
    <div className="card space-y-3 p-4">
      <p className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <IconChip icon={meta.icon} tone={meta.tone} /> {meta.label}
      </p>

      {action === 'assign' && (
        <label className="block">
          <span className="label">
            {reassign ? <>Reassign from {t.engineer_name ?? 'the current engineer'} to</> : <>Engineer at {t.trc_name}</>}
          </span>
          <select className="input mt-1" value={engineerId} onChange={e => setEngineerId(e.target.value)}>
            <option value="">Choose…</option>
            {engineers.map(e => <option key={e.employee_id} value={e.employee_id}>{e.full_name} · {e.ecode}</option>)}
          </select>
          {members && engineers.length === 0 && (
            <p className="mt-1 text-xs text-cyrixRed-700">
              {reassign ? 'Nobody else' : 'Nobody'} at this Revive Lab has the engineer box ticked. An admin adds them under People &amp; Revive Labs.
            </p>
          )}
        </label>
      )}

      {action === 'transfer' && (
        <label className="block">
          <span className="label">Transfer to</span>
          <select className="input mt-1" value={toTrc} onChange={e => setToTrc(e.target.value)}>
            <option value="">Choose…</option>
            {destinations.map(x => <option key={x.id} value={x.id}>{x.name} · {TRC_KIND_LABEL[x.kind]}</option>)}
          </select>
        </label>
      )}

      {action === 'dispatch' && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">Send it back to</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-900">
            {t.return_address || <span className="text-ink-400">No return address on the route card</span>}
          </p>
          {t.contact_number && <p className="mt-1 text-xs text-ink-500">Contact {t.contact_number}</p>}
        </div>
      )}

      {needsCourier && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label">Courier{action === 'dispatch' && <span className="text-cyrixRed-600"> *</span>}</span>
            <input className="input mt-1" value={courier} onChange={e => setCourier(e.target.value)} placeholder="DTDC, Blue Dart…" />
          </label>
          <label className="block">
            <span className="label">Tracking / AWB</span>
            <input className="input mt-1" value={awb} onChange={e => setAwb(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Dispatched on</span>
            <input className="input mt-1" type="date" value={on} onChange={e => setOn(e.target.value)} />
          </label>
        </div>
      )}

      <label className="block">
        <span className="label">
          {action === 'transfer' ? 'Why it is being transferred'
            : action === 'return' ? 'Why it is going back'
              : action === 'complete' ? 'Action taken'
                : action === 'observe' ? 'What was found'
                : action === 'received' ? 'Final status'
                  : 'Note (optional)'}
          {needsNote && <span className="text-cyrixRed-600"> *</span>}
        </span>
        <textarea
          className="input mt-1"
          rows={2}
          value={note}
          onChange={e => setNote(e.target.value)}
          placeholder={
            action === 'complete' ? 'What was done — parts replaced, tests run'
              : action === 'observe' ? 'e.g. Burnt track near the fuse; C12 bulged, replacing it'
              : action === 'received' ? 'e.g. Received, installed and working'
              : action === 'transfer' ? 'e.g. Needs FPGA rework this Revive Lab cannot do'
                : action === 'return' ? 'e.g. Cannot be repaired at this Revive Lab'
                  : reassign ? 'e.g. On leave this week'
                    : ''
          }
        />
      </label>

      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {meta.label}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
