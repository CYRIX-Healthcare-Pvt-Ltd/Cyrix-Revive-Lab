import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Boxes, CheckCircle2, ClipboardList, ExternalLink, Hand, PackageCheck, PackagePlus, Receipt, ScanText, Send, ShoppingCart,
  Undo2, X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useApproveUse, useCancelPart, useCancelUse, useComponentUses, useConfirmPart, useDeclinePart, useDeclineUse,
  useForwardPart, useMakeLocal, useOrderPart, usePartNo, usePartRequests, usePurchasePart, useSetPartProgress, useStockPart,
  useTakePart,
  type ComponentUse, type PartRequest, type Ticket,
} from '@/lib/queries'
import {
  buysFor, partActor, partStatusLook, poLabel, runsTrc, PART_PROGRESS, PART_ROUTE_LABEL, STOCK_USE_STATUS, TONE_CLASS,
  type PartProgress,
} from '@/lib/tickets'
import { signedLinks } from '@/lib/partFiles'
import { dateTime } from '@/lib/when'
import { readBillAmount } from '@/lib/billOcr'
import { Alert, Spinner } from '@/components/ui'
import IconChip from '@/components/IconChip'
import Dialog from '@/components/Dialog'
import Lightbox from '@/components/Lightbox'
import PhotoPick, { type PickedPhoto } from '@/components/PhotoPick'

/** '22 Sept, 10:57 AM' — twelve-hour, AM or PM, whatever the device's clock (lib/when). */
const when = (iso: string | null) => (iso ? dateTime(iso, false) : '')

/** A date without a time — a PO's, a delivery's — read as that day wherever the reader is. */
const onDay = (d: string | null) =>
  d ? new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''

/** Today, as a date field holds it. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Who a request goes back to: the engineer who asked for it. */
const asker = (r: PartRequest) => r.requested_by_name ?? 'the engineer'

export const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

/** Bill pages are kept sharper than a photo of a fault: the print has to be readable. */
const BILL_SIZE = { maxSide: 2000, targetBytes: 600 * 1024 }

type Notice = { kind: 'success' | 'error'; text: string } | null

/**
 * Components on a ticket: what came off the Revive Lab's stock, and what had
 * to be bought.
 *
 * Stock waits for the coordinator before it comes off the count. A request
 * shows its whole journey — asked, taken on or passed to Purchase, bought
 * with a bill or ordered with a PO, added to stock, confirmed — so the field engineer
 * reading the ticket can see what the repair is waiting for. The buttons on
 * each belong to whoever moves it next (rl_0016).
 */
export default function PartsCard({ ticket: t }: { ticket: Ticket }) {
  const { me } = useAuth()
  const { data: uses } = useComponentUses(t.id)
  const { data: requests } = usePartRequests(t.id)

  const paths = useMemo(() => (requests ?? []).flatMap(r => [r.photo_path, ...r.bill_paths]).filter((p): p is string => !!p), [requests])
  const { data: links } = useQuery({
    enabled: paths.length > 0,
    queryKey: ['revive', 'part-links', paths],
    staleTime: 50 * 60_000,
    queryFn: () => signedLinks(paths),
  })

  const [billFor, setBillFor] = useState<PartRequest | null>(null)
  const [orderFor, setOrderFor] = useState<PartRequest | null>(null)
  const [stockFor, setStockFor] = useState<PartRequest | null>(null)
  const [declineFor, setDeclineFor] = useState<PartRequest | null>(null)
  const [refuseUse, setRefuseUse] = useState<ComponentUse | null>(null)
  const [viewing, setViewing] = useState<{ images: string[]; index: number } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)

  if ((uses ?? []).length === 0 && (requests ?? []).length === 0) return null

  const desk = runsTrc(me, t.trc_id)
  const spent = (requests ?? []).filter(r => r.bill_amount !== null).reduce((a, r) => a + (r.bill_amount ?? 0), 0)

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-ink-200 bg-ink-50 px-4 py-2">
        <IconChip icon={Boxes} tone="orange" />
        <h3 className="text-sm font-semibold text-ink-800">Components</h3>
        {spent > 0 && <span className="ml-auto text-xs text-ink-500">Purchased for this ticket: <span className="font-medium tabular-nums text-ink-800">{rupees(spent)}</span></span>}
      </div>
      <div className="space-y-4 p-4">
        {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

        {(uses ?? []).length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">From stock</p>
            <ul className="mt-1.5 space-y-2">
              {uses!.map(u => (
                <StockUseItem
                  key={u.id}
                  use={u}
                  desk={desk}
                  isAsker={u.requested_by === me?.employee_id}
                  onDecline={() => { setNotice(null); setRefuseUse(u) }}
                  onNotice={setNotice}
                />
              ))}
            </ul>
          </div>
        )}

        {(requests ?? []).length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">Requested</p>
            <ul className="mt-1.5 space-y-2.5">
              {[...requests!].reverse().map(r => (
                <RequestItem
                  key={r.id}
                  r={r}
                  links={links ?? {}}
                  mine={partActor(r, me, r.trc_id, t.engineer_id)}
                  desk={runsTrc(me, r.trc_id)}
                  buyer={buysFor(me, r.trc_id)}
                  isEngineer={t.engineer_id === me?.employee_id}
                  onBill={() => { setNotice(null); setBillFor(r) }}
                  onOrder={() => { setNotice(null); setOrderFor(r) }}
                  onStock={() => { setNotice(null); setStockFor(r) }}
                  onDecline={() => { setNotice(null); setDeclineFor(r) }}
                  onView={(images, index) => setViewing({ images, index })}
                  onNotice={setNotice}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {billFor && (
        <BillDialog
          ticket={t}
          request={billFor}
          onClose={() => setBillFor(null)}
          onDone={text => { setBillFor(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      {orderFor && (
        <OrderDialog
          ticket={t}
          request={orderFor}
          onClose={() => setOrderFor(null)}
          onDone={text => { setOrderFor(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      {stockFor && (
        <StockDialog
          request={stockFor}
          onClose={() => setStockFor(null)}
          onDone={text => { setStockFor(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      {declineFor && (
        <DeclineDialog
          request={declineFor}
          buyer={buysFor(me, declineFor.trc_id) && !runsTrc(me, declineFor.trc_id)}
          onClose={() => setDeclineFor(null)}
          onDone={text => { setDeclineFor(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      {refuseUse && (
        <DeclineUseDialog
          use={refuseUse}
          onClose={() => setRefuseUse(null)}
          onDone={text => { setRefuseUse(null); setNotice({ kind: 'success', text }) }}
        />
      )}
      <Lightbox
        images={(viewing?.images ?? []).map((src, i) => ({ src, alt: `Photo ${i + 1}` }))}
        index={viewing?.index ?? null}
        onIndex={i => setViewing(v => (v ? { ...v, index: i } : v))}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}

/** A running of a mutation with the card's own message line. */
const runner = (onNotice: (n: Notice) => void) => async (fn: () => Promise<unknown>, done: string) => {
  onNotice(null)
  try { await fn(); onNotice({ kind: 'success', text: done }) }
  catch (err) { onNotice({ kind: 'error', text: err instanceof Error ? err.message : 'That did not go through.' }) }
}

function StockUseItem({ use: u, desk, isAsker, onDecline, onNotice }: {
  use: ComponentUse
  desk: boolean
  isAsker: boolean
  onDecline: () => void
  onNotice: (n: Notice) => void
}) {
  const approve = useApproveUse()
  const cancel = useCancelUse()
  const run = runner(onNotice)
  const status = STOCK_USE_STATUS[u.status]
  const busy = approve.isPending || cancel.isPending
  const waiting = u.status === 'requested'

  return (
    <li className="rounded-lg border border-ink-200 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium tabular-nums text-ink-900">{u.qty} ×</span>
        <span className="text-ink-900">{u.value ?? u.item ?? u.part_no}</span>
        <span className="font-mono text-xs text-ink-500">{u.part_no}</span>
        {(u.item || u.package) && <span className="text-xs text-ink-400">{[u.item, u.package].filter(Boolean).join(' · ')}</span>}
        <span className={clsx('badge', TONE_CLASS[status.tone])}>{status.label}</span>
        {u.source === 'bought' && <span className="badge bg-ink-100 text-ink-600">From what was purchased</span>}
      </div>
      <p className="mt-0.5 text-xs text-ink-500">
        Requested by {u.requested_by_name} · {when(u.requested_at)}
        {u.decided_at && (
          <> · {u.status === 'approved' ? 'approved' : u.status === 'declined' ? 'not approved' : 'decided'} by {u.decided_by_name} · {when(u.decided_at)}</>
        )}
        {waiting && <> · {u.in_stock} in stock</>}
      </p>
      {u.decision_note && <p className="mt-1 text-sm text-ink-700">{u.decision_note}</p>}

      {waiting && (desk || isAsker) && (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-ink-100 pt-2">
          {desk && (
            <>
              <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy}
                onClick={() => run(() => approve.mutateAsync({ id: u.id }), `${u.qty} × ${u.part_no} off the stock.`)}>
                {approve.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-green-400" />} Approve
              </button>
              <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy} onClick={onDecline}>
                <X className="h-4 w-4 text-rose-600" /> Decline
              </button>
            </>
          )}
          {isAsker && !desk && (
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy}
              onClick={() => run(() => cancel.mutateAsync({ id: u.id }), 'Taken back.')}>
              <Undo2 className="h-4 w-4 text-slate-500" /> Take it back
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function RequestItem({
  r, links, mine, desk, buyer, isEngineer, onBill, onOrder, onStock, onDecline, onView, onNotice,
}: {
  r: PartRequest
  links: Record<string, string>
  /** Whose move it is now. */
  mine: boolean
  desk: boolean
  buyer: boolean
  isEngineer: boolean
  onBill: () => void
  onOrder: () => void
  onStock: () => void
  onDecline: () => void
  onView: (images: string[], index: number) => void
  onNotice: (n: Notice) => void
}) {
  const take = useTakePart()
  const forward = useForwardPart()
  const makeLocal = useMakeLocal()
  const confirm = useConfirmPart()
  const cancel = useCancelPart()
  const setProgress = useSetPartProgress()
  const run = runner(onNotice)
  const status = partStatusLook(r)
  const photo = r.photo_path ? links[r.photo_path] : undefined
  const bills = r.bill_paths.map(p => links[p]).filter(Boolean)
  const busy = take.isPending || forward.isPending || makeLocal.isPending || confirm.isPending || cancel.isPending
    || setProgress.isPending

  const steps: Array<[ReactNode, string | null]> = [
    [<>Requested by {r.requested_by_name}</>, r.requested_at],
    ...(r.accepted_at ? [[<>{r.accepted_by_name} is purchasing it</>, r.accepted_at] as [ReactNode, string]] : []),
    ...(r.progress && r.progress_at ? [[<>{PART_PROGRESS[r.progress]}{r.progress_by_name ? <> · {r.progress_by_name}</> : null}</>, r.progress_at] as [ReactNode, string]] : []),
    ...(r.declined_at ? [[<>Declined by {r.declined_by_name}{r.declined_reason ? <>: <span className="text-ink-700">{r.declined_reason}</span></> : null}</>, r.declined_at] as [ReactNode, string]] : []),
    ...(r.purchased_at && r.po_number ? [[<>Ordered by {r.purchased_by_name} · <span className="font-mono text-ink-700">{poLabel(r.po_number)}</span>{r.po_date ? <> of {onDay(r.po_date)}</> : null}{r.vendor ? <> from {r.vendor}</> : null}{r.edd ? <> · due <span className="font-medium text-ink-800">{onDay(r.edd)}</span></> : null}</>, r.purchased_at] as [ReactNode, string]] : []),
    ...(r.purchased_at && !r.po_number ? [[<>Purchased by {r.purchased_by_name}{r.bill_amount !== null ? <> for <span className="font-medium tabular-nums text-ink-800">{rupees(r.bill_amount)}</span></> : null}{r.vendor ? <> from {r.vendor}</> : null}{r.bill_no ? <> · bill {r.bill_no}</> : null}</>, r.purchased_at] as [ReactNode, string]] : []),
    ...(r.stocked_at ? [[<>Into stock by {r.stocked_by_name} as <span className="font-mono text-ink-700">{r.part_no}</span>{r.bought_qty ? <> · {r.bought_qty} purchased</> : null}</>, r.stocked_at] as [ReactNode, string]] : []),
    ...(r.received_at ? [[<>Confirmed by {r.received_by_name}</>, r.received_at] as [ReactNode, string]] : []),
  ]

  // Whoever it is with now, and the ways out for the engineer who asked.
  // The coordinator takes a local purchase on; Purchase goes straight to the order (rl_0019).
  const canTake = desk && r.status === 'requested' && r.route === 'local'
  const canForward = desk && (r.status === 'requested')
  const canMakeLocal = desk && (r.status === 'forwarded' || (r.status === 'requested' && r.route === 'purchase'))
  const canOrder = buyer && r.route === 'purchase' && (r.status === 'forwarded' || r.status === 'accepted')
  const canBill = mine && r.status === 'accepted' && r.route === 'local'
  const canProgress = desk && r.status === 'accepted' && r.route === 'local'
  const canStock = desk && r.status === 'bought'
  const canDecline = (desk && ['requested', 'accepted'].includes(r.status)) || (buyer && ['forwarded', 'accepted'].includes(r.status))
  const canConfirm = isEngineer && r.status === 'sent'
  const canCancel = isEngineer && ['requested', 'forwarded', 'accepted'].includes(r.status)
  const anyAction = canTake || canForward || canMakeLocal || canOrder || canBill || canProgress || canStock || canDecline
    || canConfirm || canCancel

  return (
    <li className="rounded-lg border border-ink-200 p-3">
      <div className="flex flex-wrap items-start gap-3">
        {photo && (
          <button type="button" onClick={() => onView([photo], 0)} className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-ink-200" aria-label="View the component photo">
            <img src={photo} alt="" className="h-full w-full object-cover" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-ink-900">
            <span className="tabular-nums">{r.qty} ×</span> {r.name}
            <span className={clsx('badge', TONE_CLASS[status.tone])}>{status.label}</span>
            {r.progress && r.status === 'accepted' && !canProgress && (
              <span className="badge bg-yellow-50 text-yellow-900 ring-1 ring-inset ring-yellow-200">{PART_PROGRESS[r.progress]}</span>
            )}
            <span className="badge bg-ink-100 text-ink-600">{PART_ROUTE_LABEL[r.route]}</span>
          </p>
          {r.note && <p className="mt-1 text-sm text-ink-600">{r.note}</p>}
          {r.link && (
            <a href={r.link} target="_blank" rel="noopener noreferrer" className="link-accent mt-1 inline-flex max-w-full items-center gap-1 text-xs">
              <ExternalLink className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{r.link}</span>
            </a>
          )}
          <ul className="mt-1.5 space-y-0.5 text-xs text-ink-500">
            {steps.map(([what, at], i) => <li key={i}>{what} · {when(at)}</li>)}
          </ul>
          {bills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {bills.map((src, i) => (
                <button key={src} type="button" onClick={() => onView(bills, i)} className="h-16 w-16 overflow-hidden rounded-md border border-ink-200" aria-label={`View bill page ${i + 1}`}>
                  <img src={src} alt="" className="h-full w-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* The next move, for whoever it belongs to. */}
      {anyAction && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-100 pt-3">
          {canTake && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy}
              onClick={() => run(() => take.mutateAsync({ id: r.id }), 'Taken on. Mark where it stands as you go, and attach the bill once it is purchased.')}>
              {take.isPending ? <Spinner className="h-4 w-4" /> : <Hand className="h-4 w-4 text-yellow-400" />}
              Purchase locally
            </button>
          )}
          {canOrder && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={onOrder}>
              <ClipboardList className="h-4 w-4 text-violet-300" /> Enter the order
            </button>
          )}
          {canProgress && (
            <label className="inline-flex items-center gap-2 text-sm">
              <span className="text-ink-500">Status</span>
              <select
                className="input !w-auto !py-1.5 text-sm"
                value={r.progress ?? ''}
                disabled={busy}
                aria-label="Where this local purchase stands"
                onChange={e => {
                  const next = (e.target.value || null) as PartProgress | null
                  void run(() => setProgress.mutateAsync({ id: r.id, progress: next }),
                    next ? `Marked ${PART_PROGRESS[next].toLowerCase()}.` : 'Status cleared.')
                }}
              >
                <option value="">—</option>
                <option value="enquiry_given">{PART_PROGRESS.enquiry_given}</option>
                <option value="order_placed">{PART_PROGRESS.order_placed}</option>
              </select>
            </label>
          )}
          {canForward && (
            <button type="button" className={clsx(r.route === 'purchase' ? 'btn-primary' : 'btn-secondary', '!py-1.5 text-sm')} disabled={busy}
              onClick={() => run(() => forward.mutateAsync({ id: r.id }), 'Passed to Purchase. They purchase it and it comes back to you for the stock entry.')}>
              {forward.isPending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4 text-amber-500" />} Pass to Purchase
            </button>
          )}
          {canMakeLocal && (
            <button type="button" className={clsx(r.status === 'forwarded' ? 'btn-secondary' : 'btn-primary', '!py-1.5 text-sm')} disabled={busy}
              onClick={() => run(() => makeLocal.mutateAsync({ id: r.id }), 'Kept here — purchase it locally and attach the bill.')}>
              {makeLocal.isPending ? <Spinner className="h-4 w-4" /> : <ShoppingCart className="h-4 w-4 text-orange-500" />} Purchase locally
            </button>
          )}
          {canBill && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={onBill}>
              <Receipt className="h-4 w-4 text-cyan-400" /> Attach the bill
            </button>
          )}
          {canStock && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={onStock}>
              <PackagePlus className="h-4 w-4 text-violet-400" /> Add to stock and send to {asker(r)}
            </button>
          )}
          {canDecline && (
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy} onClick={onDecline}>
              <X className="h-4 w-4 text-rose-600" /> {buyer && !desk ? 'Hand back' : 'Decline'}
            </button>
          )}
          {canConfirm && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy}
              onClick={() => run(() => confirm.mutateAsync({ id: r.id }), 'Confirmed — carry on with the repair.')}>
              {confirm.isPending ? <Spinner className="h-4 w-4" /> : <PackageCheck className="h-4 w-4 text-green-400" />} Confirm
            </button>
          )}
          {canCancel && (
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy}
              onClick={() => { if (window.confirm(`Cancel the request for ${r.qty} × ${r.name}?`)) void run(() => cancel.mutateAsync({ id: r.id }), 'Request cancelled.') }}>
              <Undo2 className="h-4 w-4 text-slate-500" /> Cancel request
            </button>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * Bought: the bill's pages and its amount. The first page is read as it is
 * added and its total put in the amount box — a suggestion to check against
 * the photo, not a figure to trust.
 */
function BillDialog({ ticket: t, request: r, onClose, onDone }: {
  ticket: Ticket
  request: PartRequest
  onClose: () => void
  onDone: (message: string) => void
}) {
  const purchase = usePurchasePart()
  const [pages, setPages] = useState<PickedPhoto[]>([])
  const [amount, setAmount] = useState('')
  const [billNo, setBillNo] = useState('')
  const [vendor, setVendor] = useState('')
  const [reading, setReading] = useState<number | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [firstPage, setFirstPage] = useState<File | null>(null)

  // Read the first page once, as soon as there is one.
  useEffect(() => {
    if (!firstPage) return
    let cancelled = false
    setReading(0); setReadNote(null)
    readBillAmount(firstPage, p => { if (!cancelled) setReading(p) })
      .then(({ amount: found }) => {
        if (cancelled) return
        if (found !== null) {
          setAmount(a => a || String(found))
          setReadNote(`Read ${found.toLocaleString('en-IN')} from the bill — check it against the photo.`)
        } else {
          setReadNote('No total could be read from the bill. Enter the amount.')
        }
      })
      .catch(() => { if (!cancelled) setReadNote('The bill could not be read here. Enter the amount.') })
      .finally(() => { if (!cancelled) setReading(null) })
    return () => { cancelled = true }
  }, [firstPage])

  const send = async () => {
    setError(null)
    if (pages.length === 0) { setError('Attach the bill.'); return }
    const n = Number(amount)
    if (!amount.trim() || !Number.isFinite(n) || n < 0) { setError('Enter the bill amount.'); return }
    try {
      await purchase.mutateAsync({
        ticketId: t.id, id: r.id, amount: n, bills: pages.map(p => p.blob),
        billNo: billNo.trim(), vendor: vendor.trim(),
      })
      onDone(`Bill saved: ${r.qty} × ${r.name}, ${rupees(n)}. Now add it to stock and send it to ${asker(r)}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Attach the bill" icon={<IconChip icon={Receipt} tone="cyan" />} onClose={onClose}>
      <p className="text-sm text-ink-600">
        {r.qty} × {r.name} <span className="text-ink-400">· {PART_ROUTE_LABEL[r.route]} for {t.code}</span>
      </p>

      <div>
        <span className="label">Bill <span className="text-cyrixRed-600">*</span></span>
        <div className="mt-1">
          <PhotoPick
            photos={pages}
            onChange={setPages}
            max={3}
            noun="bill page"
            size={BILL_SIZE}
            onOriginal={f => { if (pages.length === 0 && !firstPage) setFirstPage(f) }}
          />
        </div>
        {reading !== null && (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-ink-500">
            <ScanText className="h-3.5 w-3.5 text-cyan-600" /> Reading the bill… {Math.round(reading * 100)}%
          </p>
        )}
        {readNote && reading === null && <p className="mt-1.5 text-xs text-ink-500">{readNote}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Amount (₹) <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 tabular-nums" type="number" inputMode="decimal" min={0} step="0.01"
            value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        </label>
        <label className="block">
          <span className="label">Bill number</span>
          <input className="input mt-1" value={billNo} onChange={e => setBillNo(e.target.value)} maxLength={60} />
        </label>
      </div>
      <label className="block">
        <span className="label">Purchased from</span>
        <input className="input mt-1" value={vendor} onChange={e => setVendor(e.target.value)} maxLength={120} placeholder="Shop or supplier" />
      </label>

      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={purchase.isPending}>
          {purchase.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Save the bill
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

/**
 * What was bought, written into the Revive Lab's stock and sent on.
 *
 * The part number comes from the stock itself: the one this Revive Lab
 * already uses for that value and item, or the next free C number. What the
 * engineer asked for goes to the repair; whatever was bought over and above
 * stays on the shelf.
 */
function StockDialog({ request: r, onClose, onDone }: {
  request: PartRequest
  onClose: () => void
  onDone: (message: string) => void
}) {
  const stock = useStockPart()
  const [value, setValue] = useState(r.name)
  const [item, setItem] = useState('')
  const [pack, setPack] = useState('')
  const [partNo, setPartNo] = useState('')
  const [touchedPartNo, setTouchedPartNo] = useState(false)
  const [qty, setQty] = useState(String(r.qty))
  const [useQty, setUseQty] = useState(String(r.qty))
  const [error, setError] = useState<string | null>(null)
  const suggestion = usePartNo(r.trc_id, value, item)

  // The number follows the value and item until somebody types their own.
  useEffect(() => {
    if (!touchedPartNo && suggestion.data) setPartNo(suggestion.data)
  }, [suggestion.data, touchedPartNo])

  const bought = Number(qty)
  const toRepair = Number(useQty)
  const known = suggestion.data && suggestion.data === partNo && !touchedPartNo

  const send = async () => {
    setError(null)
    if (value.trim().length < 1) { setError('Enter the value — what is printed on the part.'); return }
    if (!Number.isInteger(bought) || bought < 1) { setError('Enter how many were purchased.'); return }
    if (!Number.isInteger(toRepair) || toRepair < 0 || toRepair > bought) { setError('The repair cannot take more than was purchased.'); return }
    try {
      await stock.mutateAsync({
        id: r.id, value: value.trim(), item: item.trim(), package: pack.trim(),
        partNo: partNo.trim() || null, qty: bought, useQty: toRepair,
      })
      onDone(`${bought} into stock as ${partNo.trim() || 'a new part'}${toRepair ? `, ${toRepair} sent to ${asker(r)}` : ''}. They confirm it and carry on.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title={`Add to stock and send to ${asker(r)}`} icon={<IconChip icon={PackagePlus} tone="violet" />} onClose={onClose} wide>
      <p className="text-sm text-ink-600">
        {asker(r)} requested <span className="font-medium text-ink-900">{r.qty} × {r.name}</span>
        {r.po_number ? <> · {poLabel(r.po_number)}</> : null}
        {r.vendor ? <> · {r.po_number ? 'ordered' : 'purchased'} from {r.vendor}</> : null}
        {r.bill_amount !== null ? <> · {rupees(r.bill_amount)}</> : null}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Value <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1" value={value} onChange={e => setValue(e.target.value)} maxLength={160}
            placeholder="e.g. IRF640, 10k 1%" />
        </label>
        <label className="block">
          <span className="label">Item</span>
          <input className="input mt-1" value={item} onChange={e => setItem(e.target.value)} maxLength={80}
            placeholder="e.g. MOSFET, RESISTOR" />
        </label>
        <label className="block">
          <span className="label">Type</span>
          <input className="input mt-1" value={pack} onChange={e => setPack(e.target.value)} maxLength={40}
            placeholder="e.g. TH, SMD" />
        </label>
        <label className="block">
          <span className="label">Part number</span>
          <input className="input mt-1 font-mono" value={partNo} maxLength={40}
            onChange={e => { setPartNo(e.target.value); setTouchedPartNo(true) }} />
          <span className="mt-1 block text-xs text-ink-500">
            {suggestion.isFetching ? 'Looking it up…'
              : known ? 'This Revive Lab’s number for that value and item — new ones are made up here.'
                : 'Typed in by hand.'}
          </span>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">How many were purchased <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 tabular-nums" type="number" inputMode="numeric" min={1} step={1}
            value={qty} onChange={e => setQty(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">To this repair</span>
          <input className="input mt-1 tabular-nums" type="number" inputMode="numeric" min={0} step={1}
            value={useQty} onChange={e => setUseQty(e.target.value)} />
          <span className="mt-1 block text-xs text-ink-500">
            {Number.isFinite(bought) && Number.isFinite(toRepair) && bought - toRepair > 0
              ? `${bought - toRepair} stays in stock.`
              : 'The rest stays in stock.'}
          </span>
        </label>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={stock.isPending}>
          {stock.isPending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />} Add to stock and send
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

/**
 * Purchase's order: the PO number and date, when it should arrive, and
 * from whom. It then waits with the coordinator, who adds it to stock and
 * sends it to the engineer when it comes (rl_0019).
 */
function OrderDialog({ ticket: t, request: r, onClose, onDone }: {
  ticket: Ticket
  request: PartRequest
  onClose: () => void
  onDone: (message: string) => void
}) {
  const order = useOrderPart()
  const [poNumber, setPoNumber] = useState('')
  const [poDate, setPoDate] = useState(today())
  const [edd, setEdd] = useState('')
  const [vendor, setVendor] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setError(null)
    if (!poNumber.trim()) { setError('Enter the PO number.'); return }
    if (!poDate) { setError('Enter the PO date.'); return }
    if (!edd) { setError('Enter the expected delivery date.'); return }
    if (edd < poDate) { setError('The expected delivery date cannot be before the PO date.'); return }
    if (vendor.trim().length < 2) { setError('Enter the vendor’s name.'); return }
    try {
      await order.mutateAsync({ id: r.id, poNumber: poNumber.trim(), poDate, edd, vendor: vendor.trim() })
      onDone(`Ordered: ${poLabel(poNumber)}, due ${onDay(edd)}. It is with the coordinator, who adds it to stock and sends it to ${asker(r)} when it arrives.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Enter the order" icon={<IconChip icon={ClipboardList} tone="violet" />} onClose={onClose}>
      <p className="text-sm text-ink-600">
        {r.qty} × {r.name} <span className="text-ink-400">· for {t.code}, requested by {asker(r)}</span>
      </p>
      {/* Inputs level with each other when a label runs to two lines. */}
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">PO number <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 font-mono" value={poNumber} onChange={e => setPoNumber(e.target.value)} maxLength={60} />
        </label>
        <label className="block">
          <span className="label">PO date <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1" type="date" value={poDate} max={today()} onChange={e => setPoDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Expected delivery (EDD) <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1" type="date" value={edd} min={poDate || undefined} onChange={e => setEdd(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Vendor name <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1" value={vendor} onChange={e => setVendor(e.target.value)} maxLength={120} placeholder="Supplier" />
        </label>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={order.isPending}>
          {order.isPending ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4" />} Send to the coordinator
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

function DeclineDialog({ request: r, buyer, onClose, onDone }: {
  request: PartRequest
  /** Purchase handing it back to the coordinator, rather than the coordinator refusing it. */
  buyer: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const decline = useDeclinePart()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setError(null)
    if (reason.trim().length < 3) { setError('Say why it is not being purchased.'); return }
    try {
      await decline.mutateAsync({ id: r.id, reason: reason.trim() })
      onDone(buyer
        ? 'Handed back to the coordinator, with your reason. They may still find it locally.'
        : 'Declined. The engineer sees why and can ask another way.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title={buyer ? 'Hand back to the coordinator' : 'Decline request'} icon={<IconChip icon={ShoppingCart} tone="rose" />} onClose={onClose}>
      <p className="text-sm text-ink-600">{r.qty} × {r.name} · {PART_ROUTE_LABEL[r.route]}</p>
      <label className="block">
        <span className="label">Why <span className="text-cyrixRed-600">*</span></span>
        <textarea className="input mt-1" rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
          placeholder={buyer ? 'e.g. None of our suppliers stock it' : 'e.g. Not available locally — use the IRFP450 in stock'} />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={decline.isPending}>
          {decline.isPending && <Spinner className="h-4 w-4" />} {buyer ? 'Hand back' : 'Decline'}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

/** Enough of a stock use to refuse it: the ticket's card and the desk's list share this. */
export interface RefusableUse {
  id: string
  qty: number
  part_no: string
  value: string | null
  item: string | null
  in_stock: number
}

export function DeclineUseDialog({ use: u, onClose, onDone }: {
  use: RefusableUse
  onClose: () => void
  onDone: (message: string) => void
}) {
  const decline = useDeclineUse()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setError(null)
    if (reason.trim().length < 3) { setError('Say why it is not approved.'); return }
    try {
      await decline.mutateAsync({ id: u.id, reason: reason.trim() })
      onDone('Not approved. The engineer sees why.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Not off the stock" icon={<IconChip icon={Boxes} tone="rose" />} onClose={onClose}>
      <p className="text-sm text-ink-600">
        {u.qty} × {u.value ?? u.item ?? u.part_no} <span className="font-mono text-xs text-ink-500">{u.part_no}</span>
        <span className="text-ink-400"> · {u.in_stock} in stock</span>
      </p>
      <label className="block">
        <span className="label">Why <span className="text-cyrixRed-600">*</span></span>
        <textarea className="input mt-1" rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
          placeholder="e.g. Those are for the Ernakulam job — use C-118 instead" />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={decline.isPending}>
          {decline.isPending && <Spinner className="h-4 w-4" />} Decline
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}
