import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import clsx from 'clsx'
import {
  ArrowLeft, ArrowRightLeft, BadgeCheck, Ban, Boxes, CalendarClock, Camera, CheckCircle2, CircleCheck, CircleX, ClipboardCheck,
  ClipboardList, Forward, Hand, History as HistoryIcon, PackageCheck, PackagePlus, PackageX, PlayCircle, Receipt, RotateCcw, ScanSearch, Tag,
  Send, ShieldQuestion, ShieldX, ShoppingCart, Signpost, Timer, Trash2, TriangleAlert, Truck, Undo2, UserCheck, UserCog, UserPlus,
  UserX, Wrench, X,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useAccept, useAddObservation, useAnswerHandover, useApprove, useAssign, useCancelHandover, useCancelTransfer, useCloseTicket, useCompleteRepair,
  useFindPeople, useHandOver, usePhoneOf,
  useDeclineApproval, useDiscard, useDispatch, useHops, useMarkReceived, useMembers, useRequestTransfer, useReroute,
  usePartRequests, useReturnToDesk, useReturnToLab, useScrap, useSend, useSetClassification, useSetExpectedDate, useStartRepair, useTickets,
  useTrail, useTrcs, useUpdateCourier,
  type PastRound, type Person, type Ticket, type TrailEvent,
} from '@/lib/queries'
import {
  actionsFor, approversOf, canClassify, itemsSummary, mergeDeskRaise, orList, ordinal, parseTicketCode, roundOf, serves, stateLabel,
  CATEGORY_TAT_DAYS, CRITICALITY_LABEL,
  ITEM_KIND_LABEL, OUTCOME_LABEL, REPAIRING, STATUS, TONE_DOT, TONE_SOFT, TONE_TEXT, TRC_KIND_LABEL, statusLook,
  type Action, type Approval, type Criticality, type Outcome, type Proposal, type SpareCategory, type TicketItem,
  type TicketSource, type Tone,
} from '@/lib/tickets'
import { categoryTat, formatSpan, ticketTat, type Span } from '@/lib/tat'
import { dateTime, dayDate, gapLabel, gapWords, localDay } from '@/lib/when'
import { ClassificationFields, TatChip } from '@/components/Classification'
import Choices, { type ChoiceOption } from '@/components/Choices'
import { Alert, EmptyState, PageLoader, SectorTag, Spinner, StatusBadge, WarehouseChip } from '@/components/ui'
import IconChip from '@/components/IconChip'
import AttachmentsCard from '@/components/TicketAttachments'
import PartsCard, { rupees } from '@/components/PartsCard'
import { RequestPartForm, UseComponentForm } from '@/components/PartForms'
import Dialog from '@/components/Dialog'
import LabOptions from '@/components/LabOptions'
import PhotoPick, { type PickedPhoto } from '@/components/PhotoPick'
import { MediaCapture, revealLength, type PendingPhoto } from '@/components/Attachments'
import Lightbox from '@/components/Lightbox'
import { removeVideoOf } from '@/lib/attachments'
import { signedLinks } from '@/lib/partFiles'

/** "21 Sept 2026, 11:53 AM" — twelve-hour, AM or PM, whatever the device's clock (lib/when). */
const when = (iso: string | null | undefined) => (iso ? dateTime(iso) : '—')

const day = (iso: string | null | undefined) => (iso ? dayDate(iso) : null)

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

/** Back to the list as it was left — its tab, filters and order ride along from it. */
function BackLink() {
  const list = (useLocation().state as { list?: string } | null)?.list ?? ''
  return (
    <Link to={'/tickets' + list} className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
      <ArrowLeft className="h-4 w-4" /> All tickets
    </Link>
  )
}

/** The statuses a request to go to another Revive Lab puts a ticket in. */
const DECIDING = ['awaiting_approval', 'approved', 'not_approved']

function TicketView({ ticket: t }: { ticket: Ticket }) {
  const { me } = useAuth()
  // Set by the raise screen when a photo or the voice note did not upload.
  const uploadFailed = (useLocation().state as { uploadFailed?: string[] } | null)?.uploadFailed
  const { data: trail } = useTrail(t.id)
  const { data: hops } = useHops(t.id)

  const actions = actionsFor(t, me)
  // Only moves: an observation or a tracking number starts no clock.
  const tat = useMemo(() => ticketTat((trail ?? []).filter(e => e.kind === 'status'), t.trc_id), [trail, t.trc_id])
  const summary = itemsSummary(t)
  const items: TicketItem[] = t.items?.length ? t.items : t.spare_name ? [{ kind: 'spare', name: t.spare_name }] : []
  const approval = t.approval && DECIDING.includes(t.status) ? t.approval : null
  const trcName = (id: string | null) => trail?.find(e => e.trc_id === id)?.trc_name
    ?? hops?.find(h => h.to_trc_id === id)?.to_trc_name ?? (id === t.trc_id ? t.trc_name : '—')

  return (
    <div className="space-y-5">
      <BackLink />

      <div className="card overflow-hidden">
        {/* The status, along the top of the card: the page says where the
            spare is before a word of it is read. */}
        <div aria-hidden className={clsx('h-1', TONE_DOT[statusLook(t.status, t.closure, t.proposal).tone])} />
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-2xl font-semibold text-ink-900">{t.code}</h1>
              <StatusBadge status={t.status} closure={t.closure} proposal={t.proposal} full />
              {t.source === 'warehouse' && <WarehouseChip />}
            </div>
            <p className="mt-1 text-sm text-ink-600">
              {t.facility} <SectorTag ticket={t} className="mx-0.5" />{summary ? ` · ${summary}` : ''}
            </p>
            <p className="mt-0.5 text-xs text-ink-500"><WhereItIs ticket={t} /></p>
            <Classification ticket={t} />
            {/* What the field engineer waits for instead of phoning. */}
            {t.expected_by && (t.status === 'assigned' || REPAIRING.includes(t.status)) && (
              <p className={clsx(
                'mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                t.expected_by < localToday() ? 'bg-amber-100 text-amber-900' : 'bg-indigo-100 text-indigo-900',
              )}>
                <CalendarClock className="h-3.5 w-3.5" />
                {t.expected_by < localToday() ? 'Repair was expected by' : 'Repair expected by'} {day(t.expected_by)}
              </p>
            )}
            {(t.arrival_damaged || t.return_damaged) && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
                <TriangleAlert className="h-3.5 w-3.5" />
                Damaged in transit {t.arrival_damaged ? 'on the way in' : ''}{t.arrival_damaged && t.return_damaged ? ' and ' : ''}{t.return_damaged ? 'on the way back' : ''}
              </p>
            )}
            {/* Fitted, not working, and sent back: the Revive Lab repairs it again (rl_0027). */}
            {(t.field_returns ?? []).length > 0 && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-rose-100 px-2 py-1 text-xs font-medium text-rose-900">
                <RotateCcw className="h-3.5 w-3.5" />
                Returned not working{t.field_returns.length > 1 ? ` — ${t.field_returns.length} times` : ''}
                {t.status !== 'closed' && <> · round {roundOf(t)}</>}
              </p>
            )}
            {/* A hospital's spare is fitted and said to work, or not. A warehouse's
                goes back into its stock and nobody tests it there, so it says only
                that (the user, 23 Sep: "working is not logical for a warehouse"). */}
            {t.status === 'closed' && t.source === 'warehouse' && t.closure === 'returned' && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-green-100 px-2 py-1 text-xs font-medium text-green-900">
                <PackageCheck className="h-3.5 w-3.5" /> Back in warehouse stock
              </p>
            )}
            {t.status === 'closed' && t.source !== 'warehouse' && t.final_working !== null && (
              <p className={clsx(
                'mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                t.final_working ? 'bg-green-100 text-green-900' : 'bg-rose-100 text-rose-900',
              )}>
                <CircleCheck className="h-3.5 w-3.5" /> {t.final_working ? 'Fitted and working' : 'Fitted — not working'}
              </p>
            )}
            {t.status === 'closed' && t.closure === 'scrapped' && (
              <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-900">
                <Trash2 className="h-3.5 w-3.5" /> Moved to scrap{t.scrapped_at ? ` ${day(t.scrapped_at)}` : ''}{t.scrapped_by_name ? ` by ${t.scrapped_by_name}` : ''}
              </p>
            )}
            {t.outcome && t.outcome !== 'repaired' && t.status !== 'closed' && !['not_repairable', 'service_denied'].includes(t.status) && (
              <p className="mt-2 text-xs text-ink-500">Repair closed as {OUTCOME_LABEL[t.outcome].toLowerCase()}</p>
            )}
            {approval && <ApprovalNote ticket={t} approval={approval} />}
            <HandoverNote ticket={t} />
          </div>
          {/* Right-aligned beside the title; on a phone it drops below it, and lines up on the left. */}
          <div className="sm:text-right">
            <p className="label !mb-0">{t.status === 'closed' ? 'Total TAT' : 'Open for'}</p>
            <p className="text-2xl font-semibold tabular-nums text-ink-900">{formatSpan(tat.total.ms)}</p>
          </div>
        </div>

        {actions.length > 0 && (
          <div className="border-t border-ink-200 bg-ink-50 p-4 sm:px-5">
            <ActionBar ticket={t} actions={actions} spoken={(trail ?? []).filter(e => e.voice_path).length} />
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
              {/* A warehouse's spare has neither (rl_0020). */}
              {t.source !== 'warehouse' && <Row label="District">{t.district}</Row>}
              {t.source !== 'warehouse' && <Row label="BEMMP">{t.bemmp_code}</Row>}
              {t.billing_spare !== null && t.billing_spare !== undefined && (
                <Row label="Billing spare">{t.billing_spare ? 'Yes' : 'No'}</Row>
              )}
              {t.contract_type && <Row label="Contract type">{t.contract_type}</Row>}
              {t.billing_estimate !== null && t.billing_estimate !== undefined && (
                <Row label="Estimated billing">
                  <span className="font-medium tabular-nums">{rupees(Number(t.billing_estimate))}</span>
                  <span className="text-xs text-ink-500"> · entered on dispatch</span>
                </Row>
              )}
              <Row label="Revive Lab">
                {t.trc_name}
                <span className="text-xs text-ink-500"> · {stateLabel(t.trc_state)}</span>
              </Row>
              <Row label={t.source === 'warehouse' ? 'Warehouse' : 'Hospital name'}>{t.facility}</Row>
              <Row label="Equipment barcode">{t.equipment_barcode && <span className="font-mono">{t.equipment_barcode}</span>}</Row>
              <Row label="Equipment name">{t.equipment_name}</Row>
              <Row label="Make">{t.equipment_make}</Row>
              <Row label="Model">{t.equipment_model}</Row>
              <Row label="Spares and accessories">
                {items.length > 0 && (
                  <ul className="space-y-1">
                    {items.map((it, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>{it.name}</span>
                        <span className="rounded bg-ink-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-label text-ink-500">
                          {ITEM_KIND_LABEL[it.kind]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
              {t.source !== 'warehouse' && (
                <Row label="Ticket ID">{t.source_ticket_no && <span className="font-mono">{t.source_ticket_no}</span>}</Row>
              )}
              <Row label="Raised on">{when(t.created_at)}</Row>
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
              <Row label={t.source === 'warehouse' ? 'Warehouse in-charge' : 'Field engineer'}>
                {t.stakeholder_name} <span className="text-xs text-ink-400">{t.stakeholder_ecode}</span>
                {t.stakeholder_function && <span className="text-xs text-ink-500"> · {t.stakeholder_function}</span>}
                {t.handover?.status === 'accepted' && t.handover.to_id === t.stakeholder_id && (
                  <span className="block text-xs text-violet-700">Took it over from {t.handover.from_name}, {when(t.handover.decided_at)}</span>
                )}
              </Row>
              <Row label="Their manager">{t.stakeholder_manager_name}</Row>
              <Row label="Revive Lab engineer">
                {t.engineer_name && <>{t.engineer_name} <span className="text-xs text-ink-400">{t.engineer_ecode}</span></>}
              </Row>
            </dl>
          </Section>

          <AttachmentsCard ticket={t} />

          <StageMedia ticket={t} />

          <PartsCard ticket={t} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Section title="Courier details" icon={Truck} tone="teal">
              <Courier
                name={t.in_courier} awb={t.in_awb} on={t.in_dispatched_on}
                empty={t.status === 'pending_acceptance' || DECIDING.includes(t.status) ? 'Not added yet' : 'Not recorded'}
              />
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

          {(t.field_returns ?? []).length > 0 && <ReturnsCard ticket={t} />}

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
          {!trail ? <Spinner className="h-4 w-4 text-ink-400" /> : <Timeline trail={trail} proposal={t.proposal} source={t.source} />}
        </Section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Where the spare is and whose move it is, in one line. Most statuses say
 * it plainly; a request to go to another Revive Lab, and a spare that
 * cannot be repaired, say what was asked for.
 */
function WhereItIs({ ticket: t }: { ticket: Ticket }) {
  const a = t.approval
  const at = (
    <>
      At {t.trc_name}
      {!t.trc_name.toLowerCase().includes(TRC_KIND_LABEL[t.trc_kind].toLowerCase()) && <> ({TRC_KIND_LABEL[t.trc_kind]})</>}
    </>
  )
  switch (t.status) {
    case 'awaiting_approval':
      return a?.kind === 'transfer'
        ? <>{at} · transfer to {a.to_trc_name} waiting on the Regional Revive Lab admins</>
        : <>For {t.trc_name} · waiting on the Regional Revive Lab admins to approve it</>
    case 'approved':
      return a?.kind === 'transfer'
        ? <>{at} · transfer to {a.to_trc_name} approved · waiting on the coordinator to send it</>
        : <>Approved for {t.trc_name} · waiting on {t.stakeholder_name} to send it</>
    case 'not_approved':
      return <>{t.trc_name} not approved · waiting on {t.stakeholder_name} to send it elsewhere or discard it</>
    case 'not_repairable':
      return (
        <>
          {at} · waiting on the coordinator to {t.proposal === 'scrap' ? 'move it to scrap, as the engineer proposed'
            : t.proposal === 'return' ? 'dispatch it back, as the engineer proposed'
              : 'move it to scrap or dispatch it back'}
        </>
      )
    case 'closed':
      return t.closure === 'discarded' ? <>Discarded before it was sent to a Revive Lab</> : at
    case 'in_transit_return':
      // Being handed to another field engineer: theirs to take up first (rl_0028).
      if (t.handover?.status === 'pending') return <>Dispatched back · waiting on {t.handover.to_name} to accept the transfer</>
      return <>{at} · waiting on {STATUS[t.status]?.waitingOn}</>
    default:
      return <>{at} · waiting on {STATUS[t.status]?.waitingOn}</>
  }
}

/**
 * A transfer to another field engineer, waiting to be answered (rl_0028) —
 * said to the one asked as a question, to the one who asked as a wait, and
 * to everybody else as where the ticket stands.
 */
function HandoverNote({ ticket: t }: { ticket: Ticket }) {
  const { me } = useAuth()
  const h = t.handover
  if (!h || h.status !== 'pending') return null
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2.5 text-sm text-violet-900">
      <Forward className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
      <div>
        <p className="font-medium">
          {me?.employee_id === h.to_id
            ? <>{h.from_name} is handing this ticket to you — accept it to take the spare over.</>
            : me?.employee_id === h.from_id
              ? <>Waiting for {h.to_name} ({h.to_ecode}) to accept the transfer.</>
              : <>Being transferred from {h.from_name} to {h.to_name} ({h.to_ecode}) — waiting for them to accept.</>}
        </p>
        <p className="mt-0.5 text-xs text-violet-700">Asked {when(h.requested_at)} · {h.to_name}: {h.phone}</p>
      </div>
    </div>
  )
}

const APPROVAL_LOOK = {
  awaiting_approval: { icon: ShieldQuestion, box: 'border-fuchsia-200 bg-fuchsia-50', ink: 'text-fuchsia-900', mark: 'text-fuchsia-600' },
  approved: { icon: BadgeCheck, box: 'border-emerald-200 bg-emerald-50', ink: 'text-emerald-900', mark: 'text-emerald-600' },
  not_approved: { icon: ShieldX, box: 'border-pink-200 bg-pink-50', ink: 'text-pink-900', mark: 'text-pink-600' },
} as const

/**
 * The request to go to another Revive Lab, on the ticket itself: what was
 * asked and why, who decides, and what they said — so nobody has to phone
 * to find out why the spare has not moved.
 */
function ApprovalNote({ ticket: t, approval: a }: { ticket: Ticket; approval: Approval }) {
  const { data: members } = useMembers()
  const { data: trcs } = useTrcs()
  const look = APPROVAL_LOOK[t.status as keyof typeof APPROVAL_LOOK]
  if (!look) return null
  const approvers = approversOf(members ?? [], trcs ?? [])
  const to = <>{a.to_trc_name}<span className="font-normal"> · {stateLabel(a.to_trc_state)}</span></>

  return (
    <div className={clsx('mt-3 max-w-xl rounded-lg border px-3 py-2.5', look.box)}>
      <p className={clsx('flex items-start gap-2 text-sm font-medium', look.ink)}>
        <look.icon className={clsx('mt-0.5 h-4 w-4 shrink-0', look.mark)} />
        <span>
          {t.status === 'awaiting_approval'
            ? <>{a.kind === 'transfer' ? 'Transfer requested to ' : 'Requested for '}{to}</>
            : t.status === 'approved'
              ? <>Approved for {to}{a.to_trc_id !== a.asked_trc_id && <span className="font-normal"> instead of {a.asked_trc_name}</span>}</>
              : <>{a.to_trc_name} not approved</>}
        </span>
      </p>
      <div className="mt-1 space-y-1 pl-6">
        <p className="whitespace-pre-wrap text-sm text-ink-700">{a.reason}</p>
        <p className="text-xs text-ink-500">Requested by {a.requested_by_name} · {when(a.requested_at)}</p>
        {t.status === 'awaiting_approval' && approvers.length > 0 && (
          <p className="text-xs text-ink-500">Waiting on {orList(approvers)}</p>
        )}
        {t.status !== 'awaiting_approval' && a.decided_by_name && (
          <>
            <p className="text-xs text-ink-500">
              {t.status === 'approved' ? 'Approved' : 'Not approved'} by {a.decided_by_name} · {when(a.decided_at)}
            </p>
            {a.decision_note && <p className="whitespace-pre-wrap text-sm text-ink-700">{a.decision_note}</p>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The photographs the steps take: how the spare arrived, the repair
 * working, and how it came back. Kept apart from the route card's own
 * photos, which say what was wrong rather than what was done.
 */
/** One round's photographs and recordings: the ticket's own for the round it is on, a return's for the one before (rl_0027). */
type RoundMedia = Pick<PastRound,
  'arrival_photos' | 'arrival_damaged' | 'done_photos' | 'done_video' | 'done_voice' | 'return_photos' | 'return_damaged'>

function StageMedia({ ticket: t }: { ticket: Ticket }) {
  // Newest first: the round it is on, then each one before it came back not working.
  const rounds: Array<{ n: number; media: RoundMedia }> = [
    ...(t.field_returns ?? []).map((r, i) => ({ n: i + 1, media: r.before })),
    { n: roundOf(t), media: t },
  ].reverse()
  const several = rounds.length > 1
  const pathsOf = (m: RoundMedia) => [
    ...(m.arrival_photos ?? []), ...(m.done_photos ?? []), ...(m.return_photos ?? []),
    ...(m.done_video ? [m.done_video] : []), ...(m.done_voice ? [m.done_voice] : []),
  ]
  const paths = rounds.flatMap(r => pathsOf(r.media))
  const { data: links } = useQuery({
    enabled: paths.length > 0,
    queryKey: ['revive', 'stage-media', t.id, paths.join(',')],
    staleTime: 30 * 60_000,
    queryFn: () => signedLinks(paths),
  })
  const [viewing, setViewing] = useState<number | null>(null)
  if (paths.length === 0) return null

  const shots = rounds.flatMap(({ n, media: m }) => {
    const of = several ? ` — round ${n}` : ''
    return [
      ...(m.arrival_photos ?? []).map(p => ({ path: p, alt: `As it arrived at the Revive Lab${of}` })),
      ...(m.done_photos ?? []).map(p => ({ path: p, alt: `The repaired spare${of}` })),
      ...(m.return_photos ?? []).map(p => ({ path: p, alt: `As it arrived back${of}` })),
    ]
  }).filter(x => links?.[x.path])

  const group = (title: string, tone: string, list: string[], damaged: boolean) => list.length === 0 ? null : (
    <div>
      <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-label text-ink-400">
        {title}
        {damaged && (
          <span className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] normal-case tracking-normal', tone)}>
            <TriangleAlert className="h-3 w-3" /> Damaged in transit
          </span>
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {list.map(p => {
          const at = shots.findIndex(x => x.path === p)
          return links?.[p] ? (
            <button key={p} type="button" onClick={() => setViewing(at)} className="h-20 w-20 overflow-hidden rounded-lg border border-ink-200">
              <img src={links[p]} alt="" className="h-full w-full object-cover" />
            </button>
          ) : null
        })}
      </div>
    </div>
  )

  const round = (m: RoundMedia) => (
    <>
      {group('On arrival', 'bg-amber-100 text-amber-900', m.arrival_photos ?? [], !!m.arrival_damaged)}
      {group('Repaired', 'bg-lime-100 text-lime-900', m.done_photos ?? [], false)}
      {m.done_video && links?.[m.done_video] && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">The repair, running</p>
          <video src={links[m.done_video]} controls playsInline className="mt-1.5 max-h-72 w-full rounded-lg border border-ink-200 bg-shade" />
        </div>
      )}
      {m.done_voice && links?.[m.done_voice] && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">The engineer, on the repair</p>
          <audio src={links[m.done_voice]} controls onLoadedMetadata={revealLength} className="mt-1.5 h-10 w-full" />
        </div>
      )}
      {group('Back with the field engineer', 'bg-amber-100 text-amber-900', m.return_photos ?? [], !!m.return_damaged)}
    </>
  )

  return (
    <Section
      title={rounds.some(r => r.media.done_video || r.media.done_voice) ? 'Arrival, repair and return — photos and recordings' : 'Arrival, repair and return photos'}
      icon={Camera}
      tone="sky"
    >
      {!several ? (
        <div className="space-y-4">{round(t)}</div>
      ) : (
        // Every round kept, each under its number: the first time is history too (the user, 23 Sep).
        <div className="space-y-3">
          {rounds.filter(r => pathsOf(r.media).length > 0).map(({ n, media }) => (
            <div key={n} className="space-y-4 rounded-lg border border-ink-200 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-700">
                {n === roundOf(t)
                  ? <>Round {n}{t.status !== 'closed' && <span className="font-normal text-ink-500"> · this time</span>}</>
                  : <>Round {n} <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-px text-[10px] text-rose-900"><RotateCcw className="h-3 w-3" /> came back not working</span></>}
              </p>
              {round(media)}
            </div>
          ))}
        </div>
      )}
      <Lightbox
        images={shots.map(x => ({ src: links?.[x.path] ?? '', alt: x.alt }))}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
      />
    </Section>
  )
}

/**
 * Each time the field engineer fitted it, found it not working and sent it
 * back (rl_0027): why, how it went, and what the round before had — its
 * category and TAT, who repaired it, how it was dispatched. That round's
 * photographs are under its number above, and every step of it is in the
 * history.
 */
function ReturnsCard({ ticket: t }: { ticket: Ticket }) {
  const returns = t.field_returns ?? []
  return (
    <Section title={returns.length > 1 ? `Returned not working — ${returns.length} times` : 'Returned not working'} icon={RotateCcw} tone="rose">
      <ol className="space-y-3">
        {returns.map((r, i) => {
          const b = r.before
          const tat = categoryTat({ spare_category: b.spare_category, accepted_at: b.accepted_at, dispatched_at: b.dispatched_at })
          const went = [
            b.engineer_name && `Repaired by ${b.engineer_name}${b.engineer_ecode ? ` ${b.engineer_ecode}` : ''}`,
            b.outcome && b.outcome !== 'repaired' && `closed as ${OUTCOME_LABEL[b.outcome].toLowerCase()}`,
            b.out_courier && `dispatched back by ${b.out_courier}${b.out_awb ? `, AWB ${b.out_awb}` : ''}${b.out_dispatched_on ? `, on ${day(b.out_dispatched_on)}` : ''}`,
            b.billing_estimate !== null && b.billing_estimate !== undefined && `estimated billing ${rupees(Number(b.billing_estimate))}`,
            b.received_at && `received ${when(b.received_at)}${b.return_damaged ? ', damaged in transit' : ''}`,
          ].filter(Boolean)
          return (
            <li key={r.at} className="rounded-lg border border-ink-200 p-3">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium text-ink-900">
                <RotateCcw className="h-4 w-4 text-rose-600" />
                {ordinal(i + 1)} return, to {r.trc_name}
                <span className="text-xs font-normal text-ink-400">· {when(r.at)}{r.by_name ? ` · by ${r.by_name}` : ''}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{r.reason}</p>
              <p className="mt-1 text-xs text-ink-500">
                {[r.courier, r.awb && `AWB ${r.awb}`, day(r.dispatched_on) && `sent ${day(r.dispatched_on)}`].filter(Boolean).join(' · ')}
              </p>
              <div className="mt-2.5 rounded-md bg-ink-50 px-2.5 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-label text-ink-400">Round {i + 1}, before it came back</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {b.spare_category && (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">
                      <Tag aria-hidden className="h-3 w-3" /> Category {b.spare_category}
                      {b.criticality && <> · {CRITICALITY_LABEL[b.criticality]}</>}
                    </span>
                  )}
                  {tat && <TatChip tat={tat} />}
                </div>
                {went.length > 0 && <p className="mt-1.5 text-xs text-ink-600">{went.join(' · ')}</p>}
              </div>
            </li>
          )
        })}
      </ol>
    </Section>
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
/** A component request's steps, by the button that made them. */
const PART_STEP: Record<string, { title: string; icon: LucideIcon; tone: Tone }> = {
  used: { title: 'Used from stock', icon: Boxes, tone: 'indigo' },
  requested: { title: 'Component requested', icon: ShoppingCart, tone: 'orange' },
  accepted: { title: 'Purchase accepted', icon: Hand, tone: 'yellow' },
  forwarded: { title: 'Passed to Purchase', icon: Send, tone: 'amber' },
  made_local: { title: 'To be purchased locally', icon: ShoppingCart, tone: 'yellow' },
  handed_back: { title: 'Handed back by Purchase', icon: Undo2, tone: 'orange' },
  enquiry_given: { title: 'Local purchase — enquiry given', icon: ShoppingCart, tone: 'yellow' },
  order_placed: { title: 'Local purchase — order placed', icon: ShoppingCart, tone: 'yellow' },
  progress_cleared: { title: 'Local purchase — status cleared', icon: ShoppingCart, tone: 'slate' },
  ordered: { title: 'Ordered by Purchase', icon: Receipt, tone: 'violet' },
  declined: { title: 'Purchase declined', icon: X, tone: 'rose' },
  purchased: { title: 'Purchased — bill attached', icon: Receipt, tone: 'violet' },
  stocked: { title: 'Added to stock and sent to the engineer', icon: PackagePlus, tone: 'cyan' },
  stock_asked: { title: 'Requested from stock', icon: Boxes, tone: 'orange' },
  stock_used: { title: 'Taken from stock', icon: Boxes, tone: 'indigo' },
  stock_declined: { title: 'Stock not approved', icon: X, tone: 'rose' },
  stock_cancelled: { title: 'Stock request taken back', icon: Undo2, tone: 'slate' },
  confirmed: { title: 'Purchase confirmed', icon: PackageCheck, tone: 'green' },
  cancelled: { title: 'Component request cancelled', icon: Undo2, tone: 'slate' },
}

/** The steps after which the repair carries on, when nothing else is waiting. */
const RESUMES = ['confirmed', 'declined', 'cancelled', 'stock_used', 'stock_declined', 'stock_cancelled']

function stepLook(
  e: TrailEvent, earlier: TrailEvent[], proposal: Proposal | null, source?: TicketSource | null,
): { title: ReactNode; tone: Tone; icon: LucideIcon } {
  const tone = STATUS[e.status]?.tone ?? 'sky'
  if (e.kind === 'eta') return { title: 'Expected repair date changed', tone: 'indigo', icon: CalendarClock }
  // The desk's category and criticality, set or changed (rl_0024).
  if (e.kind === 'classify') {
    const n = e.note ?? ''
    const cat = n.includes('Category')
    const crit = /Critical|Non-critical/.test(n)
    const what = cat && crit ? 'Category and criticality' : cat ? 'Category' : 'Criticality'
    return { title: `${what} ${n.includes('→') ? 'changed' : 'set'}`, tone: 'violet', icon: Tag }
  }

  // Going to another Revive Lab (rl_0014). Checked before the component
  // steps: "declined" is theirs too, and only these come from waiting for approval.
  if (e.action === 'lab_requested') {
    return { title: e.from_status === null ? 'Raised — for another state’s Revive Lab' : 'Requested another state’s Revive Lab', tone, icon: ShieldQuestion }
  }
  if (e.action === 'transfer_requested') return { title: 'Transfer requested', tone, icon: ArrowRightLeft }
  if (e.action === 'approved') return { title: 'Approved', tone, icon: BadgeCheck }
  if (e.action === 'declined' && e.from_status === 'awaiting_approval') {
    return { title: e.status === 'not_approved' ? 'Not approved' : 'Transfer not approved', tone: 'pink', icon: ShieldX }
  }
  if (e.action === 'transfer_cancelled') return { title: 'Transfer cancelled', tone: 'slate', icon: Undo2 }
  if (e.action === 'discarded') return { title: 'Discarded — closed', tone: 'slate', icon: Ban }
  if (e.action === 'sent') {
    return e.status === 'transferred'
      ? { title: STATUS.transferred.label, tone, icon: ArrowRightLeft }
      : { title: 'Sent to the Revive Lab', tone, icon: Send }
  }

  if (e.action && PART_STEP[e.action] && (e.kind === 'component' || e.kind === 'status')) {
    const step = PART_STEP[e.action]
    // The last purchase confirmed puts the repair back in the engineer's hands.
    if (e.kind === 'status' && e.status === 'in_repair' && RESUMES.includes(e.action)) {
      return { title: `${step.title} — repair resumed`, tone, icon: step.icon }
    }
    return { title: step.title, tone: e.kind === 'status' ? tone : step.tone, icon: step.icon }
  }
  if (e.action === 'repaired') return { title: 'Repaired', tone, icon: ClipboardCheck }
  if (e.action === 'not_repairable') {
    return {
      title: proposal ? `Closed as not repairable — proposes ${proposal === 'scrap' ? 'scrap' : 'sending it back'}` : 'Closed as not repairable',
      tone, icon: PackageX,
    }
  }
  if (e.action === 'customer_denied') return { title: 'Customer denied service', tone, icon: UserX }
  if (e.action === 'scrapped') return { title: 'Moved to scrap — closed', tone: 'slate', icon: Trash2 }
  if (e.kind === 'observation') {
    // Numbered, so "Observation 2" can be talked about on the phone.
    const n = earlier.filter(x => x.kind === 'observation').length + 1
    return { title: `Observation ${n}`, tone, icon: ScanSearch }
  }
  // A warehouse keeps it as stock: received back closes it (rl_0023).
  if (e.action === 'received_stock') return { title: 'Received back into warehouse stock — closed', tone, icon: PackageCheck }
  if (e.action === 'damaged') return { title: e.status === 'accepted' ? 'Accepted — damaged in transit' : 'Received back — damaged in transit', tone: 'amber', icon: TriangleAlert }
  // Handed to another field engineer on its way back, and what they said (rl_0028).
  if (e.kind === 'handover') {
    switch (e.action) {
      case 'handover_asked': return { title: 'Transfer to another field engineer', tone: 'violet', icon: Forward }
      case 'handover_accepted': return { title: 'Took the ticket over', tone: 'violet', icon: UserCheck }
      case 'handover_declined': return { title: 'Declined the transfer', tone: 'slate', icon: UserX }
      default: return { title: 'Transfer cancelled', tone: 'slate', icon: Undo2 }
    }
  }
  // Fitted, not working, and sent back on the same ticket: the next round starts here (rl_0027).
  if (e.action === 'field_return') return { title: 'Returned to the Revive Lab — not working', tone: 'rose', icon: RotateCcw }
  if (e.action === 'working' || e.action === 'not_working') {
    // A warehouse ticket closed before rl_0023 went through this step too; it went back into stock.
    if (source === 'warehouse') return { title: 'Received back into warehouse stock — closed', tone, icon: PackageCheck }
    return { title: e.action === 'working' ? 'Closed — fitted and working' : 'Closed — fitted, not working', tone, icon: CircleCheck }
  }
  if (e.kind === 'courier') return { title: 'Courier details updated', tone: 'teal', icon: Truck }
  // Raised by the desk with the spare in hand: nothing to accept (mergeDeskRaise).
  if (e.action === 'raised_at_lab') return { title: 'Raised at the Revive Lab', tone, icon: PackagePlus }
  if (e.from_status === null) return { title: 'Raised', tone, icon: PackagePlus }

  switch (e.status) {
    case 'accepted':
      return e.from_status !== 'pending_acceptance' && e.from_status !== 'transferred'
        ? { title: 'Handed back to the coordinator', tone, icon: Undo2 }
        : { title: STATUS.accepted.label, tone, icon: Hand }
    case 'assigned': {
      // Any earlier assignment makes this one a reassignment — straight from
      // one engineer to another, or again after being handed back. A spare
      // sent back by the field starts a new round, assigned afresh (rl_0027).
      const round = earlier.slice(earlier.map(x => x.action).lastIndexOf('field_return') + 1)
      const again = round.some(x => x.status === 'assigned')
      const title = e.engineer_name
        ? <>{again ? 'Reassigned' : 'Assigned'} to {e.engineer_name}
          {e.engineer_ecode && <span className="font-normal text-ink-400"> {e.engineer_ecode}</span>}</>
        : again ? 'Reassigned to another engineer' : STATUS.assigned.label
      return { title, tone, icon: again ? UserCog : UserPlus }
    }
    case 'in_repair': return { title: e.from_status === 'assigned' ? 'Repair accepted' : STATUS.in_repair.label, tone, icon: Wrench }
    case 'repaired': return { title: STATUS.repaired.label, tone, icon: ClipboardCheck }
    case 'in_transit_return': return { title: STATUS.in_transit_return.label, tone, icon: Send }
    case 'received_back': return { title: 'Received back by the field engineer', tone, icon: PackageCheck }
    case 'closed': return { title: 'Closed', tone, icon: CircleCheck }
    case 'transferred': return { title: STATUS.transferred.label, tone, icon: ArrowRightLeft }
    default: return { title: STATUS[e.status]?.label ?? e.status, tone, icon: PackagePlus }
  }
}

/**
 * The history, with how long each step took to the next on the line between
 * them — the thread broken by a small pill that says so (the user, 23 Sep).
 * A wait of a day or more is picked out in amber.
 */
/** A step's note as it reads now: a warehouse ticket closed the old way lost its "Working", which it never had to say. */
function noteOf(e: TrailEvent, source: TicketSource): string | null {
  if (source === 'warehouse' && (e.action === 'working' || e.action === 'not_working')) {
    return e.note?.replace(/^(Not working|Working)( · )?/, '') || null
  }
  return e.note
}

function Timeline({ trail, proposal, source }: { trail: TrailEvent[]; proposal: Proposal | null; source: TicketSource }) {
  // Every spoken observation's link in one go, rather than one call each.
  const spoken = trail.map(e => e.voice_path).filter((p): p is string => !!p)
  const { data: voices } = useQuery({
    enabled: spoken.length > 0,
    queryKey: ['revive', 'voices', spoken.join(',')],
    staleTime: 30 * 60_000,
    queryFn: () => signedLinks(spoken),
  })
  // The desk's own raise is one step, not raised-then-accepted in the same moment (the user, 23 Sep).
  const steps = useMemo(() => mergeDeskRaise(trail), [trail])
  return (
    <ol>
      {steps.map((e, i) => {
        const look = stepLook(e, steps.slice(0, i), proposal, source)
        const next = steps[i + 1]
        const gap = next ? Math.max(0, Date.parse(next.at) - Date.parse(e.at)) : null
        return (
          <li key={e.id} className={clsx('relative flex gap-3', next && 'pb-9')}>
            {/* The thread from this step down to the next, and on it — halfway
                between the two, breaking it — how long that took. */}
            {next && <span aria-hidden className="absolute bottom-0 left-4 top-8 w-px -translate-x-1/2 bg-ink-200" />}
            {gap !== null && (
              <span
                aria-hidden
                title={`${gapWords(gap)} to the next step`}
                className={clsx(
                  'absolute left-4 top-[calc(50%+1rem)] -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold tabular-nums ring-1',
                  gap >= 86_400_000 ? 'text-amber-800 ring-amber-300' : 'text-ink-500 ring-ink-200',
                )}
              >
                {gapLabel(gap)}
              </span>
            )}
            <span className={clsx('relative grid h-8 w-8 shrink-0 place-items-center rounded-full', TONE_SOFT[look.tone])}>
              <look.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className="text-sm font-medium text-ink-900">{look.title}</p>
              <p className="mt-0.5 text-xs text-ink-500">
                {when(e.at)} · {e.actor_name ?? 'System'}{e.trc_name ? ` · ${e.trc_name}` : ''}
              </p>
              {noteOf(e, source) && (
                <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-ink-50 px-2.5 py-1.5 text-sm text-ink-700">{noteOf(e, source)}</p>
              )}
              {e.voice_path && voices?.[e.voice_path] && (
                <audio src={voices[e.voice_path]} controls preload="none" className="mt-1.5 h-9 w-full max-w-xs" />
              )}
              {gap !== null && <span className="sr-only">{gapWords(gap)} to the next step.</span>}
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

/** Stage cells per row on a computer, by how many there are. */
const CELL_COLUMNS: Record<number, string> = { 4: 'sm:grid-cols-4', 5: 'sm:grid-cols-5', 6: 'sm:grid-cols-3' }

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
  const cells: Array<[string, Span]> = [
    ['Reach Revive Lab', tat.reach],
    ['To assignment', tat.assign],
    ['Repair', tat.repair],
    ...(tat.parts.ms !== null ? [['Waiting for components', tat.parts] as [string, Span]] : []),
    ...(tat.approval.ms !== null ? [['Waiting for approval', tat.approval] as [string, Span]] : []),
    ['Dispatch & transit', tat.dispatch],
  ]
  return (
    <Section title="Turnaround" icon={Timer} tone="indigo">
      {/* Two to a row on a phone, and an odd last one across the whole row. */}
      <div className={clsx('grid-pairs grid grid-cols-2 gap-2', CELL_COLUMNS[cells.length])}>
        {cells.map(([label, span]) => <SpanCell key={label} label={label} span={span} />)}
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
                      {leg.endedBy === 'transfer' ? 'transferred on' : leg.endedBy === 'returned' ? 'came back not working'
                        : leg.endedBy === 'closed' ? 'closed' : 'current'}
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

/**
 * How much weight a move carries on the page: the move that takes the
 * ticket forward, a tool used along the way, or a way out.
 */
type Weight = 'main' | 'tool' | 'aside'

/** Each move in the colour of the status it leads to — the colour its step takes in the history. */
const ACTION_META: Record<Action, { label: string; icon: LucideIcon; tone: Tone; weight: Weight; primary?: boolean }> = {
  approve: { label: 'Approve', icon: BadgeCheck, tone: 'emerald', weight: 'main', primary: true },
  decline_approval: { label: 'Decline', icon: ShieldX, tone: 'pink', weight: 'main' },
  send: { label: 'Send', icon: Send, tone: 'red', weight: 'main', primary: true },
  reroute: { label: 'Send to another Revive Lab', icon: Signpost, tone: 'red', weight: 'main', primary: true },
  accept: { label: 'Accept', icon: Hand, tone: 'amber', weight: 'main', primary: true },
  assign: { label: 'Assign engineer', icon: UserPlus, tone: 'sky', weight: 'main', primary: true },
  start: { label: 'Accept repair', icon: PlayCircle, tone: 'indigo', weight: 'main', primary: true },
  complete: { label: 'Close repair', icon: ClipboardCheck, tone: 'lime', weight: 'main', primary: true },
  dispatch: { label: 'Dispatch back', icon: Send, tone: 'teal', weight: 'main', primary: true },
  scrap: { label: 'Move to scrap', icon: Trash2, tone: 'slate', weight: 'main', primary: true },
  received: { label: 'Received back', icon: PackageCheck, tone: 'blue', weight: 'main', primary: true },
  close_ticket: { label: 'Close ticket', icon: CircleCheck, tone: 'green', weight: 'main', primary: true },
  use_part: { label: 'Use component', icon: Boxes, tone: 'indigo', weight: 'tool' },
  request_part: { label: 'Request component', icon: ShoppingCart, tone: 'orange', weight: 'tool' },
  observe: { label: 'Add observation', icon: ScanSearch, tone: 'indigo', weight: 'tool' },
  expect: { label: 'Change expected date', icon: CalendarClock, tone: 'indigo', weight: 'tool' },
  courier: { label: 'Update courier details', icon: Truck, tone: 'teal', weight: 'tool' },
  return: { label: 'Hand back to coordinator', icon: Undo2, tone: 'amber', weight: 'aside' },
  transfer: { label: 'Transfer to another Revive Lab', icon: ArrowRightLeft, tone: 'violet', weight: 'aside' },
  cancel_transfer: { label: 'Cancel transfer', icon: Undo2, tone: 'slate', weight: 'aside' },
  discard: { label: 'Discard ticket', icon: Ban, tone: 'slate', weight: 'aside' },
  // Another field engineer takes it over while it is on its way back (rl_0028).
  hand_over: { label: 'Transfer ticket', icon: Forward, tone: 'violet', weight: 'main' },
  accept_handover: { label: 'Accept ticket', icon: UserCheck, tone: 'violet', weight: 'main', primary: true },
  decline_handover: { label: 'Decline', icon: UserX, tone: 'slate', weight: 'aside' },
  cancel_handover: { label: 'Cancel transfer', icon: Undo2, tone: 'slate', weight: 'aside' },
}

/** The field engineer's answer once it is fitted, in the colours of the two ways it can end. */
const WORKING_CHOICES: ReadonlyArray<ChoiceOption<'yes' | 'no'>> = [
  { value: 'yes', label: 'Working', hint: 'Fitted, runs', tone: 'green', icon: CircleCheck },
  { value: 'no', label: 'Not working', hint: 'Still faulty', tone: 'red', icon: CircleX },
]

/** A button says where it goes when it can. */
function actionMeta(action: Action, t: Ticket) {
  const m = ACTION_META[action]
  // Once an engineer has it, the same button gives it to somebody else.
  if (action === 'assign' && t.engineer_id) return { ...m, label: 'Reassign engineer', icon: UserCog }
  // Nothing to update yet: the card was raised before it went to a courier.
  if (action === 'courier' && !t.in_courier && !t.in_awb && !t.in_dispatched_on) return { ...m, label: 'Add courier details' }
  if (action === 'expect' && !t.expected_by) return { ...m, label: 'Set expected date' }
  if (action === 'send' && t.approval) {
    return t.approval.kind === 'transfer'
      ? { ...m, label: `Send to ${t.approval.to_trc_name}`, icon: ArrowRightLeft, tone: 'violet' as Tone }
      : { ...m, label: `Send to ${t.trc_name}` }
  }
  if (action === 'reroute' && t.state) return { ...m, label: `Send to a ${t.state} or Regional Revive Lab` }
  if (action === 'cancel_handover' && t.handover) return { ...m, label: `Cancel transfer to ${t.handover.to_name}` }
  return m
}

/**
 * The moves this person can make, and the one form each needs.
 *
 * Laid out by weight. On a phone the move forward takes the whole width,
 * the tools sit two to a row as tiles, and the ways out — handing back,
 * transferring, giving up — come last, quietly, under a rule. On a
 * computer they share one line, the ways out at its far end.
 *
 * One form open at a time, under the buttons — the question and the answer
 * together — and every move asks only for what that move records.
 */
function ActionBar({ ticket: t, actions, spoken }: { ticket: Ticket; actions: Action[]; spoken: number }) {
  const [open, setOpen] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const toggle = (a: Action) => { setOpen(open === a ? null : a); setError(null); setDone(null) }
  const weighing = (w: Weight) => actions.filter(a => ACTION_META[a].weight === w)
  const main = weighing('main')
  const tools = weighing('tool')
  const aside = weighing('aside')
  const finish = (msg: string) => { setOpen(null); setError(null); setDone(msg) }
  // Stable, so a dialog is not refocused every time the ticket refreshes behind it.
  const close = useCallback(() => setOpen(null), [])

  return (
    <div className="space-y-3">
      {error && <Alert kind="error">{error}</Alert>}
      {done && <Alert kind="success">{done}</Alert>}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {main.length > 0 && (
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            {main.map(a => {
              const m = actionMeta(a, t)
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggle(a)}
                  aria-expanded={open === a}
                  className={clsx(m.primary ? 'btn-primary' : 'btn-secondary', open === a && 'ring-2 ring-ink-400 ring-offset-1')}
                >
                  <m.icon className={clsx('h-4 w-4', TONE_TEXT[m.tone])} /> {m.label}
                </button>
              )
            })}
          </div>
        )}

        {tools.length > 0 && (
          <div className={clsx('grid gap-2 sm:flex sm:flex-wrap', tools.length > 1 && 'grid-pairs grid-cols-2')}>
            {tools.map(a => {
              const m = actionMeta(a, t)
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggle(a)}
                  aria-expanded={open === a}
                  className={clsx(
                    'btn-secondary',
                    // Tiles on a phone: the icon over the words, so a long label wraps evenly.
                    tools.length > 1 && 'flex-col gap-1.5 px-2 py-3 text-center leading-tight sm:flex-row sm:gap-2 sm:px-4 sm:py-2.5 sm:leading-normal',
                    open === a && 'ring-2 ring-ink-400 ring-offset-1',
                  )}
                >
                  <m.icon className={clsx(tools.length > 1 ? 'h-5 w-5 sm:h-4 sm:w-4' : 'h-4 w-4', TONE_TEXT[m.tone])} /> {m.label}
                </button>
              )
            })}
          </div>
        )}

        {aside.length > 0 && (
          <div className={clsx(
            'flex flex-wrap gap-x-5 gap-y-1 sm:ml-auto',
            (main.length > 0 || tools.length > 0) && 'mt-1 border-t border-ink-200 pt-2 sm:mt-0 sm:border-0 sm:pt-0',
          )}>
            {aside.map(a => {
              const m = actionMeta(a, t)
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => toggle(a)}
                  aria-expanded={open === a}
                  className={clsx(
                    'btn-press inline-flex items-center gap-1.5 rounded-md py-1.5 text-sm font-medium',
                    open === a ? 'text-ink-900 underline underline-offset-4' : 'text-ink-600 hover:text-ink-900',
                  )}
                >
                  <m.icon className={clsx('h-4 w-4', TONE_TEXT[m.tone])} /> {m.label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {open && POP_UP.includes(open) && (
        <ActionDialog key={open} ticket={t} action={open} onClose={close} onDone={finish} />
      )}
      {open === 'use_part' && (
        <UseComponentForm ticket={t} onCancel={() => setOpen(null)} onError={setError} onDone={finish} />
      )}
      {open === 'request_part' && (
        <RequestPartForm
          ticket={t}
          onCancel={() => setOpen(null)}
          onError={setError}
          onDone={(msg, warning) => { setOpen(null); setError(warning ?? null); setDone(msg) }}
        />
      )}
      {open === 'hand_over' && (
        <HandOverForm ticket={t} onCancel={() => setOpen(null)} onError={setError} onDone={finish} />
      )}
      {open && !POP_UP.includes(open) && open !== 'use_part' && open !== 'request_part' && open !== 'hand_over' && (
        <ActionForm key={open} ticket={t} action={open} spoken={spoken} onCancel={() => setOpen(null)} onError={setError} onDone={finish} />
      )}
    </div>
  )
}

/**
 * Handing the ticket to another field engineer while the spare is on its
 * way back (rl_0028; the user, 23 Sep). Type a name and the people it
 * matches are offered — choosing one fills in the rest; type an E-code in
 * full and it finds its person the same way. The phone comes from their
 * record when there is one. Every field can be changed, and all three are
 * needed. They accept it before it is theirs.
 */
function HandOverForm({ ticket: t, onCancel, onError, onDone }: {
  ticket: Ticket
  onCancel: () => void
  onError: (msg: string) => void
  onDone: (msg: string) => void
}) {
  const handOver = useHandOver()
  const [name, setName] = useState('')
  const [ecode, setEcode] = useState('')
  const [phone, setPhone] = useState('')
  const [chosen, setChosen] = useState<Person | null>(null)
  // Typing a name: the people it matches, until one is chosen.
  const [naming, setNaming] = useState(false)
  const byName = useFindPeople(naming ? name : '')
  const byCode = useFindPeople(ecode)
  const { data: onRecord } = usePhoneOf(chosen?.id)
  // The phone as it was filled in: one typed by hand is never replaced.
  const filled = useRef('')

  const choose = (p: Person) => {
    setChosen(p)
    setName(p.full_name)
    setEcode(p.ecode)
    setNaming(false)
    if (phone === filled.current) { setPhone(''); filled.current = '' }
  }
  // An E-code typed in full finds its person.
  useEffect(() => {
    const code = ecode.trim().toUpperCase()
    const exact = (byCode.data ?? []).find(p => p.ecode.toUpperCase() === code)
    if (exact && exact.id !== chosen?.id) choose(exact)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byCode.data, ecode])
  // Their phone, once known — unless one has been typed already.
  useEffect(() => {
    if (onRecord && (phone === '' || phone === filled.current)) { setPhone(onRecord); filled.current = onRecord }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRecord])

  const run = async () => {
    if (name.trim().length < 2) { onError('Enter the name of the engineer taking it over.'); return }
    if (!ecode.trim()) { onError('Enter their E-code.'); return }
    if (phone.replace(/\D/g, '').length < 10) { onError('Enter their phone number — 10 digits.'); return }
    try {
      await handOver.mutateAsync({ id: t.id, ecode: ecode.trim(), phone: phone.trim() })
      onDone(`Transfer asked of ${chosen?.full_name ?? ecode.trim().toUpperCase()}. It is theirs once they accept it — until then you can cancel it.`)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  const offered = naming && name.trim().length >= 2 ? (byName.data ?? []) : []
  return (
    <div className="card space-y-3 p-4">
      <p className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <IconChip icon={Forward} tone="violet" /> Transfer to another field engineer
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="relative block sm:col-span-3">
          <span className="label">Name <span className="text-cyrixRed-600">*</span></span>
          <input
            className="input mt-1"
            value={name}
            onChange={e => { setName(e.target.value); setNaming(true) }}
            onFocus={() => setNaming(true)}
            onBlur={() => setTimeout(() => setNaming(false), 150)}
            placeholder="Type a name — or the E-code below"
            autoComplete="off"
          />
          {naming && name.trim().length >= 2 && (
            <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-ink-200 bg-surface shadow-lg">
              {byName.isFetching && offered.length === 0 ? (
                <li className="flex items-center gap-2 px-3 py-2.5 text-sm text-ink-500"><Spinner className="h-4 w-4" /> Looking…</li>
              ) : offered.length === 0 ? (
                <li className="px-3 py-2.5 text-sm text-ink-500">Nobody active matches “{name.trim()}”.</li>
              ) : offered.map(p => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-ink-50"
                    // Before the box loses focus, so the choice is not lost with the list.
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => choose(p)}
                  >
                    <span className="block text-sm font-medium text-ink-900">{p.full_name}</span>
                    <span className="block text-xs text-ink-500">
                      {p.ecode}{p.designation ? ` · ${p.designation}` : ''}{p.department ? ` · ${p.department}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <label className="block">
          <span className="label">E-code <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 font-mono uppercase" value={ecode} onChange={e => setEcode(e.target.value)} placeholder="E1234" autoComplete="off" />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">Phone number <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 tabular-nums" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="98470 12345" />
        </label>
      </div>
      <p className="text-xs text-ink-500">
        {chosen ? `${chosen.full_name}` : 'They'} accept{chosen ? 's' : ''} it first. Then it is theirs: they confirm it arrived and close
        the ticket — or pass it on again. {t.trc_name} calls them on this number. You can cancel it until they accept.
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={handOver.isPending}>
          {handOver.isPending ? <Spinner className="h-4 w-4" /> : <Forward className="h-4 w-4" />}
          {chosen ? `Transfer to ${chosen.full_name}` : 'Transfer'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function ActionForm({
  ticket: t, action, spoken, onCancel, onError, onDone,
}: {
  ticket: Ticket
  action: Action
  /** How many observations already carry a voice note, so the next has its own name. */
  spoken: number
  onCancel: () => void
  onError: (msg: string) => void
  onDone: (msg: string) => void
}) {
  const { data: members } = useMembers()
  const { data: trcs } = useTrcs()
  const accept = useAccept()
  const assign = useAssign()
  const observe = useAddObservation()
  const giveBack = useReturnToDesk()
  const complete = useCompleteRepair()
  const dispatch = useDispatch()
  const received = useMarkReceived()
  const transfer = useRequestTransfer()
  const updateCourier = useUpdateCourier()
  const send = useSend()
  const reroute = useReroute()
  const closeTicket = useCloseTicket()
  const returnToLab = useReturnToLab()
  // Which time round it is: a later round's photographs are its own (rl_0027).
  const round = roundOf(t)
  // No date on the ticket before the day it was raised (the user, 23 Sep).
  const floor = localDay(t.created_at)

  const meta = actionMeta(action, t)
  // Reassigning: somebody has it, and the choice is who has it instead.
  const reassign = action === 'assign' && !!t.engineer_id
  // The field engineer sending their own spare, once approved.
  const sendingRaise = action === 'send' && t.approval?.kind === 'raise'

  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('repaired')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  // What this step photographs, films or says.
  const [photos, setPhotos] = useState<PickedPhoto[]>([])
  const [video, setVideo] = useState<Blob | null>(null)
  const [voice, setVoice] = useState<Blob | null>(null)
  // The repaired spare's photographs, taken the way the route card's are.
  const [shots, setShots] = useState<PendingPhoto[]>([])
  const [damaged, setDamaged] = useState(false)
  const [working, setWorking] = useState<'' | 'yes' | 'no'>('')
  // Not working: close the ticket there, or send it back to be repaired again (the user, 23 Sep).
  const [afterwards, setAfterwards] = useState<'close' | 'return' | null>(null)
  const returning = action === 'close_ticket' && working === 'no' && afterwards === 'return'
  const [engineerId, setEngineerId] = useState(reassign ? '' : t.engineer_id ?? '')
  const [toTrc, setToTrc] = useState('')
  // The field engineer's own courier details start from what is on the card.
  const fromCard = action === 'courier' || action === 'reroute' || action === 'accept' || sendingRaise
  const [courier, setCourier] = useState(fromCard ? t.in_courier ?? '' : '')
  const [awb, setAwb] = useState(fromCard ? t.in_awb ?? '' : '')
  // Accepting asks the date the sender dispatched it: blank until somebody says, never today by default.
  const [on, setOn] = useState((fromCard && t.in_dispatched_on) || (action === 'accept' ? '' : new Date().toISOString().slice(0, 10)))
  // What the Revive Lab says the spare is, on arrival (rl_0024). A CAMC spare is critical already.
  const camc = t.contract_type === 'CAMC'
  const [category, setCategory] = useState<SpareCategory | null>(t.spare_category)
  const [criticality, setCriticality] = useState<Criticality | null>(camc ? 'critical' : t.criticality)
  // How it came: required when a spare arrives from the sender; a transfer's courier was recorded when it was sent.
  // Going back to the Revive Lab, the field engineer gives all three (rl_0027).
  const courierRequired = (action === 'accept' && t.status === 'pending_acceptance') || returning
  // Under Pvt the customer can be asked to pay for the repair: what to bill, before it goes (rl_0025).
  const asksEstimate = action === 'dispatch' && !!t.asks_billing_estimate
  const [estimate, setEstimate] = useState('')
  const { data: requests } = usePartRequests(asksEstimate ? t.id : undefined)
  const purchased = (requests ?? []).reduce((sum, r) => sum + (r.bill_amount ?? 0), 0)

  const engineers = (members ?? [])
    .filter(m => m.is_engineer && m.trc_ids.includes(t.trc_id) && m.employee_id !== t.engineer_id)
  const approvers = approversOf(members ?? [], trcs ?? [])
  // Any other Revive Lab: every transfer is approved first, wherever it goes.
  const destinations = (trcs ?? []).filter(x => x.is_active && x.id !== t.trc_id)
  // Not approved: the state's own Revive Labs and the Regional ones, which need no approval.
  const nearby = (trcs ?? []).filter(x => x.is_active && serves(x, t.state))
  const labName = (id: string) => trcs?.find(x => x.id === id)?.name ?? 'that Revive Lab'

  const busy = [accept, assign, observe, giveBack, complete, dispatch, received, transfer, updateCourier, send, reroute, closeTicket, returnToLab]
    .some(m => m.isPending)
  const blobs = photos.map(p => p.blob)

  const run = async () => {
    // Nothing on the ticket happens before it was raised. A date already on
    // the card, as the sender gave it, stands as it is.
    if (needsCourier && on && on < floor && !(fromCard && on === (t.in_dispatched_on ?? ''))) {
      onError(`The date cannot be before the ticket was raised, ${day(t.created_at)}.`); return
    }
    try {
      switch (action) {
        case 'accept':
          if (!category) { onError('Choose the spare category — A, B or C.'); return }
          if (!criticality) { onError('Choose whether the spare is critical or non-critical.'); return }
          if (courierRequired && !courier.trim()) { onError('Enter the courier it came with.'); return }
          if (courierRequired && !awb.trim()) { onError('Enter the tracking / AWB number.'); return }
          if (courierRequired && !on) { onError('Enter the date of dispatch.'); return }
          if (damaged && blobs.length === 0) { onError('Photograph the damage — it is the only proof there will be.'); return }
          await accept.mutateAsync({ id: t.id, note, damaged, photos: blobs, courier, awb, on, category, criticality, round })
          onDone(`${t.code} accepted at ${t.trc_name}${damaged ? ', damaged in transit' : ''} — category ${category}, TAT ${CATEGORY_TAT_DAYS[category]} day${CATEGORY_TAT_DAYS[category] === 1 ? '' : 's'} from now.`)
          break
        case 'assign': {
          if (!engineerId) { onError('Choose the engineer.'); return }
          await assign.mutateAsync({ id: t.id, engineerId, note })
          const who = engineers.find(e => e.employee_id === engineerId)?.full_name
          onDone(`${reassign ? 'Reassigned' : 'Assigned'} to ${who ?? 'the engineer'}. They accept it before starting.`); break
        }
        case 'observe':
          if (!voice && note.trim().length < 3) { onError('Write what was found, or record it.'); return }
          await observe.mutateAsync({ id: t.id, note, voice, spoken: spoken + 1 })
          onDone('Observation added to the history. Add another whenever there is more.'); break
        case 'return':
          await giveBack.mutateAsync({ id: t.id, note }); onDone('Handed back to the coordinator.'); break
        case 'complete':
          if (outcome === 'not_repairable' && !proposal) { onError('Say what should become of it: scrap, or back to the field engineer.'); return }
          if (note.trim().length < 3) { onError(outcome === 'repaired' ? 'Say what action was taken on it.' : 'Say why.'); return }
          if (outcome === 'repaired' && shots.length === 0) { onError('Photograph the repaired spare — one photo at least.'); return }
          await complete.mutateAsync({
            id: t.id, note, outcome,
            proposal: outcome === 'not_repairable' ? proposal : null,
            photos: outcome === 'repaired' ? shots.map(p => p.blob) : [],
            video: outcome === 'repaired' ? video : null,
            voice: outcome === 'repaired' ? voice : null,
            round,
          })
          onDone(outcome === 'repaired' ? 'Repair closed. It is with the coordinator for dispatch.'
            : outcome === 'not_repairable'
              ? proposal === 'scrap'
                ? 'Closed as not repairable. The coordinator moves it to scrap, as you proposed.'
                : `Closed as not repairable. The coordinator sends it back to ${t.stakeholder_name}, as you proposed.`
              : 'Closed: the customer denied service. The coordinator sends it back.')
          break
        case 'dispatch': {
          const amount = estimate.trim() === '' ? null : Number(estimate)
          if (asksEstimate && (amount === null || !Number.isFinite(amount) || amount < 0)) {
            onError('Enter the estimated billing cost — under Pvt the customer can be asked to pay it.'); return
          }
          await dispatch.mutateAsync({ id: t.id, courier, awb, on, note, estimate: asksEstimate ? amount : null })
          onDone(asksEstimate ? `Dispatched back, with the estimated billing of ${rupees(amount!)}.` : 'Dispatched back to the field.')
          break
        }
        case 'received':
          if (damaged && blobs.length === 0) { onError('Photograph the damage — it is the only proof there will be.'); return }
          await received.mutateAsync({ id: t.id, note, damaged, photos: blobs, round })
          void removeVideoOf(t.id)
          onDone(t.source === 'warehouse'
            ? `${t.code} is back at the warehouse — the ticket is closed.`
            : `${t.code} is back with you. Once it is fitted, close the ticket — or, if it does not work, return it to ${t.trc_name}.`); break
        case 'close_ticket':
          if (!working) { onError('Say whether it works.'); return }
          if (working === 'no' && !afterwards) { onError(`Say what happens to it now: close the ticket, or return it to ${t.trc_name}.`); return }
          if (returning) {
            if (note.trim().length < 5) { onError('Say why it is going back — what is not working.'); return }
            if (!courier.trim()) { onError('Enter the courier it is going back with.'); return }
            if (!awb.trim()) { onError('Enter the tracking / AWB number.'); return }
            if (!on) { onError('Enter the date of dispatch.'); return }
            await returnToLab.mutateAsync({ id: t.id, reason: note, courier, awb, on })
            onDone(`${t.code} is on its way back to ${t.trc_name}. Its coordinator accepts it when it arrives, and it is repaired again — the first time stays in the history.`)
            break
          }
          if (note.trim().length < 2) { onError('Give the final status.'); return }
          await closeTicket.mutateAsync({ id: t.id, working: working === 'yes', note })
          onDone(`${t.code} is closed.`); break
        case 'courier':
          if (!courier.trim() && !awb.trim()) { onError('Enter the courier or the tracking number.'); return }
          await updateCourier.mutateAsync({ id: t.id, courier, awb, on })
          onDone('Courier details saved. The Revive Lab sees them on this ticket.'); break
        case 'transfer':
          if (!toTrc) { onError('Choose the Revive Lab it is going to.'); return }
          if (note.trim().length < 5) { onError('Say why it is being transferred.'); return }
          await transfer.mutateAsync({ id: t.id, toTrcId: toTrc, reason: note })
          onDone(`Transfer to ${labName(toTrc)} requested. Once the Regional Revive Lab admins approve it, send it from here.`); break
        case 'send':
          await send.mutateAsync({ id: t.id, courier, awb, on, note })
          onDone(sendingRaise
            ? `Sent to ${t.trc_name}. Their coordinators accept it when it arrives.`
            : `Transferred to ${t.approval?.to_trc_name ?? 'the Revive Lab'}. Their coordinators accept it on arrival.`)
          break
        case 'reroute':
          if (!toTrc) { onError('Choose the Revive Lab it is going to.'); return }
          await reroute.mutateAsync({ id: t.id, trcId: toTrc, courier, awb, on })
          onDone(`Sent to ${labName(toTrc)}. Their coordinators accept it when it arrives.`); break
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  // The back of the route card: the Revive Lab's Action taken, and the
  // field engineer's Final status.
  const needsNote = action === 'return' || action === 'transfer' || action === 'complete' || action === 'close_ticket' || action === 'observe'
  const needsCourier = action === 'dispatch' || action === 'courier' || action === 'send' || action === 'reroute' || action === 'accept' || returning
  // Going back, the why is asked beside the choice, before the courier.
  const asksNote = action !== 'courier' && action !== 'reroute' && !returning
  // The tick that asks for the photograph: a courier's damage, in or out.
  const asksDamage = action === 'accept' || action === 'received'

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
        <>
          <label className="block">
            <span className="label">Transfer to <span className="text-cyrixRed-600">*</span></span>
            <select className="input mt-1" value={toTrc} onChange={e => setToTrc(e.target.value)}>
              <option value="">Choose…</option>
              <LabOptions labs={destinations} first={t.state} />
            </select>
          </label>
          <p className="text-xs text-ink-500">
            The Regional Revive Lab admins{approvers.length ? <> — {orList(approvers)} —</> : null} approve it first.
            Then it comes back here to send, with the courier details.
          </p>
        </>
      )}

      {action === 'reroute' && (
        <label className="block">
          <span className="label">Revive Lab <span className="text-cyrixRed-600">*</span></span>
          <select className="input mt-1" value={toTrc} onChange={e => setToTrc(e.target.value)}>
            <option value="">Choose…</option>
            <LabOptions labs={nearby} first={t.state} />
          </select>
        </label>
      )}

      {action === 'send' && (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">Send it to</p>
          <p className="mt-0.5 text-sm text-ink-900">
            {sendingRaise ? t.trc_name : t.approval?.to_trc_name}
            <span className="text-xs text-ink-500"> · {stateLabel(sendingRaise ? t.trc_state : t.approval?.to_trc_state)}</span>
          </p>
          <p className="mt-1 text-xs text-ink-500">Approved by {t.approval?.decided_by_name ?? 'the Regional Revive Lab admins'}. They accept it when it arrives.</p>
        </div>
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

      {action === 'complete' && (
        <div>
          <span className="label">How did the repair end?</span>
          <div className="mt-1 grid gap-2 sm:grid-cols-3">
            {(['repaired', 'not_repairable', 'customer_denied'] as const).map(o => (
              <button
                key={o}
                type="button"
                onClick={() => setOutcome(o)}
                aria-pressed={outcome === o}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors',
                  outcome === o
                    ? o === 'repaired' ? 'border-lime-300 bg-lime-50 text-lime-900' : o === 'not_repairable' ? 'border-rose-300 bg-rose-50 text-rose-900' : 'border-slate-300 bg-slate-50 text-slate-900'
                    : 'border-ink-200 text-ink-700 hover:border-ink-400',
                )}
              >
                {o === 'repaired' ? <ClipboardCheck className="h-4 w-4 text-lime-600" /> : o === 'not_repairable' ? <PackageX className="h-4 w-4 text-rose-600" /> : <UserX className="h-4 w-4 text-slate-500" />}
                {OUTCOME_LABEL[o]}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The coordinator may not know what a board is worth: the engineer says, and the coordinator does it. */}
      {action === 'complete' && outcome === 'not_repairable' && (
        <div>
          <span className="label">What should become of it? <span className="text-cyrixRed-600">*</span></span>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            {(['scrap', 'return'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setProposal(p)}
                aria-pressed={proposal === p}
                className={clsx(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors',
                  proposal === p
                    ? p === 'scrap' ? 'border-slate-300 bg-slate-50 text-slate-900' : 'border-teal-300 bg-teal-50 text-teal-900'
                    : 'border-ink-200 text-ink-700 hover:border-ink-400',
                )}
              >
                {p === 'scrap' ? <Trash2 className="h-4 w-4 text-slate-500" /> : <Undo2 className="h-4 w-4 text-teal-600" />}
                {p === 'scrap' ? 'Propose scrap' : `Send back to ${t.stakeholder_name}`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">The coordinator closes it the way you propose.</p>
        </div>
      )}

      {/* What it is, first: the category sets how long the Revive Lab may keep it. */}
      {action === 'accept' && (
        <ClassificationFields
          category={category}
          criticality={criticality}
          onCategory={setCategory}
          onCriticality={setCriticality}
          camc={camc}
        />
      )}

      {asksDamage && (
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-ink-200 px-3 py-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-amber-600" checked={damaged} onChange={e => setDamaged(e.target.checked)} />
            <span className="text-sm text-ink-800">
              Damaged in transit
              <span className="block text-xs text-ink-500">The courier has done something to it. Photograph it — that is the proof.</span>
            </span>
          </label>
          <div>
            <span className="label">
              {action === 'accept' ? 'Photographs as it arrived' : 'Photographs as it came back'}
              {damaged && <span className="text-cyrixRed-600"> *</span>}
            </span>
            <div className="mt-1">
              <PhotoPick photos={photos} onChange={setPhotos} max={2} noun="photo" />
            </div>
          </div>
        </div>
      )}

      {/* A repaired spare is shown working: photographs, a clip and a word
          about it — the same three tiles as on the route card. */}
      {action === 'complete' && outcome === 'repaired' && (
        <div className="rounded-lg border border-lime-200 bg-lime-50/60 p-3">
          <p className="text-sm font-medium text-ink-900">The repaired spare</p>
          <p className="mt-0.5 text-xs text-ink-600">
            A photo of it working is needed <span className="text-cyrixRed-600">*</span> — two at most. A video of up to
            20 seconds and a voice note of up to a minute, if they help.
          </p>
          <div className="mt-2.5">
            <MediaCapture
              photos={{ value: shots, onChange: setShots, max: 2 }}
              video={{ value: video, onChange: setVideo, seconds: 20 }}
              voice={{ value: voice, onChange: setVoice }}
            />
          </div>
        </div>
      )}

      {action === 'observe' && (
        <div>
          <span className="label">Say it instead of typing it</span>
          <div className="mt-1">
            <MediaCapture voice={{ value: voice, onChange: setVoice }} />
          </div>
        </div>
      )}

      {action === 'close_ticket' && (
        <Choices
          label="Is it working?"
          required
          options={WORKING_CHOICES}
          value={working || null}
          onChange={setWorking}
        />
      )}

      {/* Not working: two ways on — it ends here, or the Revive Lab repairs it again on this ticket (rl_0027). */}
      {action === 'close_ticket' && working === 'no' && (
        <Choices
          label="What happens to it now?"
          required
          options={[
            { value: 'close', label: 'Close the ticket', hint: 'It ends here', tone: 'slate', icon: CircleCheck },
            { value: 'return', label: `Return to ${t.trc_name}`, hint: 'Repair again', tone: 'orange', icon: RotateCcw },
          ]}
          value={afterwards}
          onChange={setAfterwards}
          note={afterwards === 'return'
            ? `The same ticket goes back: ${t.trc_name}'s coordinator accepts it when it arrives, and the repair starts again. Everything so far stays in its history.`
            : undefined}
        />
      )}

      {returning && (
        <label className="block">
          <span className="label">Why is it going back? <span className="text-cyrixRed-600">*</span></span>
          <textarea
            className="input mt-1"
            rows={2}
            maxLength={500}
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. Fitted; no output after 10 minutes, same fault as before"
          />
        </label>
      )}

      {needsCourier && (
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label">
              {action === 'accept' ? 'Courier it came with' : returning ? 'Courier it goes back with' : 'Courier'}
              {(action === 'dispatch' || courierRequired) && <span className="text-cyrixRed-600"> *</span>}
            </span>
            <input className="input mt-1" value={courier} onChange={e => setCourier(e.target.value)} placeholder="DTDC, Blue Dart…" />
          </label>
          <label className="block">
            <span className="label">Tracking / AWB{courierRequired && <span className="text-cyrixRed-600"> *</span>}</span>
            <input className="input mt-1" value={awb} onChange={e => setAwb(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">
              {fromCard ? 'Date of dispatch' : 'Dispatched on'}
              {courierRequired && <span className="text-cyrixRed-600"> *</span>}
            </span>
            <input className="input mt-1" type="date" value={on} min={floor} max={action === 'accept' || returning ? localToday() : undefined} onChange={e => setOn(e.target.value)} />
          </label>
        </div>
      )}

      {asksEstimate && (
        <div className="rounded-lg border border-fuchsia-200 bg-fuchsia-50/60 p-3">
          <label className="block sm:max-w-xs">
            <span className="label">Estimated billing cost (₹) <span className="text-cyrixRed-600">*</span></span>
            <input
              className="input mt-1 tabular-nums"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={estimate}
              onChange={e => setEstimate(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <p className="mt-1.5 text-xs text-ink-600">
            {t.bemmp_code ?? 'Pvt'}{t.contract_type ? ` · ${t.contract_type}` : ''}: the customer can be asked to pay for this repair
            {purchased > 0 ? <> — components purchased for it came to <span className="font-medium tabular-nums">{rupees(purchased)}</span></> : null}.
          </p>
        </div>
      )}

      {action === 'courier' && (
        <p className="text-xs text-ink-500">You can change these until {t.trc_name} accepts the spare.</p>
      )}
      {action === 'accept' && (
        <p className="text-xs text-ink-500">
          {courierRequired
            ? 'The consignment note is in your hand — all three are needed, and what the sender already entered is filled in.'
            : 'The consignment note is in your hand — fill in whatever the sender could not, and it stays on the ticket.'}
        </p>
      )}
      {(sendingRaise || action === 'reroute') && (
        <p className="text-xs text-ink-500">No tracking number yet? Send it now and add the courier details from the ticket until it is accepted.</p>
      )}

      {asksNote && (
        <label className="block">
          <span className="label">
            {action === 'transfer' ? 'Why it is being transferred'
              : action === 'return' ? 'Why it is going back'
                : action === 'complete' ? (outcome === 'repaired' ? 'Action taken' : outcome === 'not_repairable' ? 'Why it cannot be repaired' : 'What the customer said')
                  : action === 'observe' ? (voice ? 'What was found (optional beside the recording)' : 'What was found')
                    : action === 'close_ticket' ? 'Final status'
                      : action === 'received' ? 'Note (optional)'
                        : 'Note (optional)'}
            {needsNote && <span className="text-cyrixRed-600"> *</span>}
          </span>
          <textarea
            className="input mt-1"
            rows={2}
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={action === 'transfer' ? 500 : undefined}
            placeholder={
              action === 'complete' ? (outcome === 'repaired' ? 'What was done — parts replaced, tests run' : outcome === 'not_repairable' ? 'e.g. Board delaminated, controller IC not available' : 'e.g. Hospital declined the quote')
                : action === 'observe' ? 'e.g. Burnt track near the fuse; C12 bulged, replacing it'
                  : action === 'close_ticket' ? (working === 'no' ? 'e.g. Still no output; the hospital is replacing the machine' : 'e.g. Installed and working; output steady at 12 V')
                    : action === 'received' ? 'e.g. Box opened, board looks fine'
                    : action === 'transfer' ? 'e.g. Needs FPGA rework this Revive Lab cannot do'
                      : action === 'return' ? 'e.g. Cannot be repaired at this Revive Lab'
                        : reassign ? 'e.g. On leave this week'
                          : ''
            }
          />
        </label>
      )}

      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" />
            : action === 'transfer' ? <ShieldQuestion className="h-4 w-4" />
              : returning ? <RotateCcw className="h-4 w-4" />
                : <CheckCircle2 className="h-4 w-4" />}
          {/* Never the same words as the button that opened this: that one
              asks the question, this one answers it. */}
          {action === 'transfer' ? 'Ask for approval'
            : action === 'reroute' ? 'Send'
              : action === 'received' ? 'Confirm it arrived'
                : returning ? `Return to ${t.trc_name}`
                  : action === 'close_ticket' ? 'Close the ticket'
                    : meta.label}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * What the Revive Lab says the spare is — its category and criticality —
 * and where it stands against the category's TAT, under the ticket's title
 * (rl_0024). The desk changes them from here until it is dispatched back;
 * each change is a step in the history.
 */
function Classification({ ticket: t }: { ticket: Ticket }) {
  const { me } = useAuth()
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const close = useCallback(() => setEditing(false), [])
  const tat = categoryTat(t)
  const editable = canClassify(t, me)
  if (!t.spare_category && !t.criticality && !editable) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {t.spare_category ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-violet-100 px-2 py-1 text-xs font-medium text-violet-900">
          <Tag aria-hidden className="h-3.5 w-3.5" /> Category {t.spare_category} · {CATEGORY_TAT_DAYS[t.spare_category]}-day TAT
        </span>
      ) : editable ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
          <Tag aria-hidden className="h-3.5 w-3.5" /> No category yet — set it to count the TAT
        </span>
      ) : null}
      {t.criticality && (
        <span className={clsx(
          'inline-flex items-center whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium',
          t.criticality === 'critical' ? 'bg-cyrixRed-100 text-cyrixRed-900' : 'bg-green-100 text-green-900',
        )}>
          {CRITICALITY_LABEL[t.criticality]}{t.contract_type === 'CAMC' ? ' · CAMC' : ''}
        </span>
      )}
      {tat && <TatChip tat={tat} />}
      {editable && (
        <button type="button" onClick={() => { setSaved(null); setEditing(true) }} className="link-accent inline-flex items-center gap-1 px-1 text-xs font-medium">
          Change
        </button>
      )}
      {saved && <span className="text-xs text-green-700" role="status">{saved}</span>}
      {editing && <ClassifyDialog ticket={t} onClose={close} onDone={msg => { setEditing(false); setSaved(msg) }} />}
    </div>
  )
}

function ClassifyDialog({ ticket: t, onClose, onDone }: {
  ticket: Ticket
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const set = useSetClassification()
  const camc = t.contract_type === 'CAMC'
  const [category, setCategory] = useState<SpareCategory | null>(t.spare_category)
  const [criticality, setCriticality] = useState<Criticality | null>(camc ? 'critical' : t.criticality)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    if (!category) { setError('Choose the spare category — A, B or C.'); return }
    if (!criticality) { setError('Choose whether the spare is critical or non-critical.'); return }
    if (category === t.spare_category && criticality === t.criticality) { onClose(); return }
    try {
      await set.mutateAsync({ id: t.id, category, criticality })
      onDone('Saved — the change is in the history.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Category and criticality" icon={<IconChip icon={Tag} tone="violet" />} onClose={onClose} wide>
      <ClassificationFields
        category={category}
        criticality={criticality}
        onCategory={setCategory}
        onCriticality={setCriticality}
        camc={camc}
      />
      <p className="text-xs text-ink-500">
        The TAT counts from when it was accepted{t.accepted_at ? ` — ${dateTime(t.accepted_at)}` : ''}. Each change is kept in the history.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={save} disabled={set.isPending}>
          {set.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Save
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

/** The moves that ask one small question over the page instead of a form under the buttons. */
const POP_UP: Action[] = [
  'start', 'expect', 'scrap', 'approve', 'decline_approval', 'cancel_transfer', 'discard',
  'accept_handover', 'decline_handover', 'cancel_handover',
]

/** Today in the reader's own time, as the date inputs write it. */
function localToday(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Accepting a repair asks when it will be done — the date the field
 * engineer then waits for instead of phoning. The same date can be moved
 * later. Scrap and discard ask to be sure, because they close the ticket.
 * Approving asks where to — what was asked for, or another Revive Lab.
 */
function ActionDialog({ ticket: t, action, onClose, onDone }: {
  ticket: Ticket
  action: Action
  onClose: () => void
  onDone: (msg: string) => void
}) {
  const start = useStartRepair()
  const expect = useSetExpectedDate()
  const scrap = useScrap()
  const approve = useApprove()
  const decline = useDeclineApproval()
  const cancelTransfer = useCancelTransfer()
  const discard = useDiscard()
  const answer = useAnswerHandover()
  const cancelHandover = useCancelHandover()
  const navigate = useNavigate()
  const { data: trcs } = useTrcs()
  const a = t.approval
  const h = t.handover
  // Answering or taking back a transfer asks nothing more (rl_0028).
  const noteless = action === 'accept_handover' || action === 'decline_handover' || action === 'cancel_handover'
  const [date, setDate] = useState(action === 'expect' ? t.expected_by ?? '' : '')
  const [note, setNote] = useState('')
  const [toTrc, setToTrc] = useState(action === 'approve' ? a?.to_trc_id ?? '' : '')
  const [error, setError] = useState<string | null>(null)
  const busy = [start, expect, scrap, approve, decline, cancelTransfer, discard, answer, cancelHandover].some(m => m.isPending)
  const meta = actionMeta(action, t)
  // Approving a transfer for the Revive Lab it is already at would be no transfer.
  const approvable = (trcs ?? []).filter(x => x.is_active && !(a?.kind === 'transfer' && x.id === a.from_trc_id))
  const backTo = a?.back_to ? STATUS[a.back_to]?.short.toLowerCase() : null

  const run = async () => {
    setError(null)
    try {
      if (action === 'start' || action === 'expect') {
        if (!date) { setError('Choose the date you expect it repaired.'); return }
        if (date < localToday()) { setError('Choose a date from today.'); return }
      }
      if (action === 'start') {
        await start.mutateAsync({ id: t.id, note, expectedBy: date })
        onDone(`Repair accepted. ${t.stakeholder_name} sees it is expected by ${day(date)}.`)
      } else if (action === 'expect') {
        await expect.mutateAsync({ id: t.id, expectedBy: date, note })
        onDone(`Expected date moved to ${day(date)}.`)
      } else if (action === 'scrap') {
        await scrap.mutateAsync({ id: t.id, note })
        void removeVideoOf(t.id)
        onDone(`${t.code} moved to scrap and closed.`)
      } else if (action === 'approve') {
        if (!toTrc) { setError('Choose the Revive Lab it is approved for.'); return }
        await approve.mutateAsync({ id: t.id, toTrcId: toTrc, note })
        const name = trcs?.find(x => x.id === toTrc)?.name ?? a?.to_trc_name
        onDone(a?.kind === 'transfer'
          ? `Approved. ${t.trc_name} sends it to ${name}.`
          : `Approved for ${name}. ${t.stakeholder_name} sends it now.`)
      } else if (action === 'decline_approval') {
        if (note.trim().length < 3) { setError('Say why it is not approved.'); return }
        await decline.mutateAsync({ id: t.id, note })
        onDone(a?.kind === 'transfer'
          ? `Not approved. It carries on at ${t.trc_name}.`
          : `Not approved. ${t.stakeholder_name} sends it to a ${t.state ?? 'nearby'} or Regional Revive Lab, or discards it.`)
      } else if (action === 'cancel_transfer') {
        await cancelTransfer.mutateAsync({ id: t.id, note })
        onDone('Transfer cancelled. It carries on here.')
      } else if (action === 'discard') {
        await discard.mutateAsync({ id: t.id, note })
        void removeVideoOf(t.id)
        onDone(`${t.code} is discarded.`)
      } else if (action === 'accept_handover') {
        await answer.mutateAsync({ id: t.id, accept: true })
        onDone(`${t.code} is yours now. Confirm it arrived once you have it, then close the ticket.`)
      } else if (action === 'decline_handover') {
        await answer.mutateAsync({ id: t.id, accept: false })
        // Declined, it is not theirs to see any more.
        navigate('/tickets', { replace: true })
      } else if (action === 'cancel_handover') {
        await cancelHandover.mutateAsync({ id: t.id })
        onDone(`Transfer cancelled. ${t.code} stays with you.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  const quick = [[1, 'Tomorrow'], [3, 'In 3 days'], [7, 'In a week']] as const

  return (
    <Dialog title={meta.label} icon={<IconChip icon={meta.icon} tone={meta.tone} />} onClose={onClose}>
      {action === 'scrap' && (
        <p className="text-sm text-ink-600">
          {t.proposal === 'scrap' && <>{t.engineer_name ?? 'The engineer'} proposed scrap. </>}
          {t.code} ({itemsSummary(t) ?? 'the spare'}) was closed as not repairable. Moving it to scrap closes the ticket —
          it will not be sent back to {t.stakeholder_name}, and it goes on the scrap list.
        </p>
      )}

      {(action === 'start' || action === 'expect') && (
        <>
          <p className="text-sm text-ink-600">
            {action === 'start'
              ? <>When do you expect to finish it? {t.stakeholder_name} sees this date on the ticket, so they can wait for it.</>
              : <>The date {t.stakeholder_name} sees on the ticket. Say why it moved.</>}
          </p>
          <label className="block">
            <span className="label">Expected repair date <span className="text-cyrixRed-600">*</span></span>
            {/* From today — which is never before the day it was raised. */}
            <input className="input mt-1" type="date" min={[localToday(), localDay(t.created_at)].sort()[1]} value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            {quick.map(([days, label]) => (
              <button key={days} type="button" onClick={() => setDate(localToday(days))}
                className={clsx('rounded-full border px-3 py-1 text-xs font-medium', date === localToday(days) ? 'border-indigo-300 bg-indigo-50 text-indigo-900' : 'border-ink-200 text-ink-600 hover:border-ink-400')}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {(action === 'approve' || action === 'decline_approval') && a && (
        <div className="space-y-2">
          <p className="text-sm text-ink-600">
            {a.requested_by_name} asks to {a.kind === 'transfer'
              ? <>transfer {t.code} from {a.from_trc_name} to {a.asked_trc_name}</>
              : <>send {t.code}, a {t.state} spare, to {a.asked_trc_name}</>}:
          </p>
          <p className="whitespace-pre-wrap rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-800">{a.reason}</p>
        </div>
      )}

      {action === 'approve' && (
        <label className="block">
          <span className="label">Approve for <span className="text-cyrixRed-600">*</span></span>
          <select className="input mt-1" value={toTrc} onChange={e => setToTrc(e.target.value)}>
            <option value="">Choose…</option>
            <LabOptions labs={approvable} first={a?.to_trc_state} />
          </select>
          <span className="mt-1 block text-xs text-ink-500">
            Another Revive Lab can be approved instead. {a?.kind === 'transfer' ? `${t.trc_name} sends it there.` : `${t.stakeholder_name} sends it there.`}
          </span>
        </label>
      )}

      {action === 'decline_approval' && (
        <p className="text-sm text-ink-600">
          {a?.kind === 'transfer'
            ? <>It carries on at {t.trc_name}{backTo ? <>, {backTo}</> : null}.</>
            : <>It goes back to {t.stakeholder_name}, to send to a {t.state ?? 'nearby'} or Regional Revive Lab instead, or to discard.</>}
        </p>
      )}

      {action === 'cancel_transfer' && (
        <p className="text-sm text-ink-600">
          The transfer to {a?.to_trc_name ?? 'the other Revive Lab'} is dropped{a?.status === 'approved' ? ', though it was approved' : ''}, and
          it carries on at {t.trc_name}{backTo ? <>, {backTo}</> : null}.
        </p>
      )}

      {action === 'accept_handover' && h && (
        <p className="text-sm text-ink-600">
          {h.from_name} is handing {t.code} ({itemsSummary(t) ?? 'the spare'}, for {t.facility}) to you. Accept it and it is yours:
          when it arrives you confirm it, fit it and close the ticket — or pass it on again. {t.trc_name} will call you on {h.phone}.
        </p>
      )}

      {action === 'decline_handover' && h && (
        <p className="text-sm text-ink-600">It stays with {h.from_name}, who can hand it to somebody else.</p>
      )}

      {action === 'cancel_handover' && h && (
        <p className="text-sm text-ink-600">{h.to_name} is no longer asked to take it over. It stays with you.</p>
      )}

      {action === 'discard' && (
        <p className="text-sm text-ink-600">
          {t.code} has not been sent to any Revive Lab. Discarding it closes the ticket; it stays in the list as Discarded.
        </p>
      )}

      {!noteless && (
        <label className="block">
          <span className="label">
            {action === 'expect' ? 'Why it moved' : action === 'decline_approval' ? 'Why not' : action === 'discard' ? 'Why' : 'Note'}
            {action === 'decline_approval' && <span className="text-cyrixRed-600"> *</span>}
          </span>
          <textarea className="input mt-1" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={action === 'discard' || action === 'cancel_transfer' ? 300 : 500}
            placeholder={
              action === 'expect' ? 'e.g. Waiting for a MOSFET from Purchase'
                : action === 'scrap' ? 'e.g. Not worth the courier back'
                  : action === 'decline_approval' ? 'e.g. Send it to the Regional Revive Lab instead'
                    : action === 'discard' ? 'e.g. Repaired on site after all'
                      : action === 'approve' ? 'e.g. Go ahead — they are expecting it'
                        : ''
            } />
        </label>
      )}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" /> : <meta.icon className={clsx('h-4 w-4', TONE_TEXT[meta.tone])} />}
          {action === 'expect' ? 'Save date' : meta.label}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>
          {action === 'cancel_transfer' || action === 'discard' || action === 'cancel_handover' ? 'Keep it'
            : action === 'accept_handover' || action === 'decline_handover' ? 'Not now' : 'Cancel'}
        </button>
      </div>
    </Dialog>
  )
}
