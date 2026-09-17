import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Boxes, CheckCircle2, ExternalLink, Hand, PackageCheck, Receipt, ScanText, ShoppingCart, Undo2, X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useAcceptPart, useCancelPart, useComponentUses, useConfirmPart, useDeclinePart, usePartRequests, usePurchasePart,
  type PartRequest, type Ticket,
} from '@/lib/queries'
import { handlesPart, PART_ROUTE_LABEL, PART_STATUS, TONE_CLASS } from '@/lib/tickets'
import { signedLinks } from '@/lib/partFiles'
import { readBillAmount } from '@/lib/billOcr'
import { Alert, Spinner } from '@/components/ui'
import IconChip from '@/components/IconChip'
import Dialog from '@/components/Dialog'
import Lightbox from '@/components/Lightbox'
import PhotoPick, { type PickedPhoto } from '@/components/PhotoPick'

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''

export const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

/** Bill pages are kept sharper than a photo of a fault: the print has to be readable. */
const BILL_SIZE = { maxSide: 2000, targetBytes: 600 * 1024 }

/**
 * Components on a ticket: what came out of stock, and what was asked for.
 *
 * Each request shows its whole journey — asked, taken on, bought with the
 * bill, confirmed — so the field engineer reading the ticket can see what
 * the repair is waiting for. The buttons on a request belong to whoever
 * moves it next: the coordinator or Purchase to take it on and buy it, the
 * engineer to confirm it or cancel it.
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
  const [declineFor, setDeclineFor] = useState<PartRequest | null>(null)
  const [viewing, setViewing] = useState<{ images: string[]; index: number } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  if ((uses ?? []).length === 0 && (requests ?? []).length === 0) return null

  const spent = (requests ?? []).filter(r => r.bill_amount !== null).reduce((a, r) => a + (r.bill_amount ?? 0), 0)

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-ink-200 bg-ink-50 px-4 py-2">
        <IconChip icon={Boxes} tone="orange" />
        <h3 className="text-sm font-semibold text-ink-800">Components</h3>
        {spent > 0 && <span className="ml-auto text-xs text-ink-500">Bought for this ticket: <span className="font-medium tabular-nums text-ink-800">{rupees(spent)}</span></span>}
      </div>
      <div className="space-y-4 p-4">
        {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

        {(uses ?? []).length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-label text-ink-400">Used from stock</p>
            <ul className="mt-1.5 divide-y divide-ink-100 rounded-lg border border-ink-200">
              {uses!.map(u => (
                <li key={u.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
                  <span className="font-medium tabular-nums text-ink-900">{u.qty} ×</span>
                  <span className="text-ink-900">{u.value ?? u.item ?? u.part_no}</span>
                  <span className="font-mono text-xs text-ink-500">{u.part_no}</span>
                  {(u.item || u.package) && <span className="text-xs text-ink-400">{[u.item, u.package].filter(Boolean).join(' · ')}</span>}
                  <span className="ml-auto text-xs text-ink-400">{u.used_by_name} · {when(u.at)}</span>
                </li>
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
                  canHandle={handlesPart(me, r.route, r.trc_id)}
                  isEngineer={t.engineer_id === me?.employee_id}
                  onBill={() => { setNotice(null); setBillFor(r) }}
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
      {declineFor && (
        <DeclineDialog
          request={declineFor}
          onClose={() => setDeclineFor(null)}
          onDone={text => { setDeclineFor(null); setNotice({ kind: 'success', text }) }}
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

function RequestItem({
  r, links, canHandle, isEngineer, onBill, onDecline, onView, onNotice,
}: {
  r: PartRequest
  links: Record<string, string>
  canHandle: boolean
  isEngineer: boolean
  onBill: () => void
  onDecline: () => void
  onView: (images: string[], index: number) => void
  onNotice: (n: { kind: 'success' | 'error'; text: string } | null) => void
}) {
  const accept = useAcceptPart()
  const confirm = useConfirmPart()
  const cancel = useCancelPart()
  const status = PART_STATUS[r.status]
  const photo = r.photo_path ? links[r.photo_path] : undefined
  const bills = r.bill_paths.map(p => links[p]).filter(Boolean)
  const busy = accept.isPending || confirm.isPending || cancel.isPending

  const run = async (fn: () => Promise<unknown>, done: string) => {
    onNotice(null)
    try { await fn(); onNotice({ kind: 'success', text: done }) }
    catch (err) { onNotice({ kind: 'error', text: err instanceof Error ? err.message : 'That did not go through.' }) }
  }

  const steps: Array<[ReactNode, string | null]> = [
    [<>Asked by {r.requested_by_name}</>, r.requested_at],
    ...(r.accepted_at ? [[<>Taken on by {r.accepted_by_name}</>, r.accepted_at] as [ReactNode, string]] : []),
    ...(r.declined_at ? [[<>Declined by {r.declined_by_name}{r.declined_reason ? <>: <span className="text-ink-700">{r.declined_reason}</span></> : null}</>, r.declined_at] as [ReactNode, string]] : []),
    ...(r.purchased_at ? [[<>Bought by {r.purchased_by_name}{r.bill_amount !== null ? <> for <span className="font-medium tabular-nums text-ink-800">{rupees(r.bill_amount)}</span></> : null}{r.vendor ? <> from {r.vendor}</> : null}{r.bill_no ? <> · bill {r.bill_no}</> : null}</>, r.purchased_at] as [ReactNode, string]] : []),
    ...(r.received_at ? [[<>Confirmed by {r.received_by_name}</>, r.received_at] as [ReactNode, string]] : []),
  ]

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
      {((canHandle && (r.status === 'requested' || r.status === 'accepted')) || (isEngineer && (r.status === 'purchased' || r.status === 'requested' || r.status === 'accepted'))) && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-100 pt-3">
          {canHandle && r.status === 'requested' && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy}
              onClick={() => run(() => accept.mutateAsync({ id: r.id }), `${PART_ROUTE_LABEL[r.route]} accepted. Attach the bill once it is bought.`)}>
              {accept.isPending ? <Spinner className="h-4 w-4" /> : <Hand className="h-4 w-4 text-yellow-400" />}
              Accept {r.route === 'local' ? 'local purchase' : 'purchase'}
            </button>
          )}
          {canHandle && r.status === 'accepted' && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy} onClick={onBill}>
              <Receipt className="h-4 w-4 text-cyan-400" /> Attach bill and send to engineer
            </button>
          )}
          {canHandle && (r.status === 'requested' || r.status === 'accepted') && (
            <button type="button" className="btn-secondary !py-1.5 text-sm" disabled={busy} onClick={onDecline}>
              <X className="h-4 w-4 text-rose-600" /> Decline
            </button>
          )}
          {isEngineer && r.status === 'purchased' && (
            <button type="button" className="btn-primary !py-1.5 text-sm" disabled={busy}
              onClick={() => run(() => confirm.mutateAsync({ id: r.id }), 'Purchase confirmed.')}>
              {confirm.isPending ? <Spinner className="h-4 w-4" /> : <PackageCheck className="h-4 w-4 text-green-400" />} Confirm purchase
            </button>
          )}
          {isEngineer && (r.status === 'requested' || r.status === 'accepted') && (
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
 * Bought: the bill's pages, its amount, and send. The first page is read as
 * it is added and its total put in the amount box — a suggestion to check
 * against the photo, not a figure to trust.
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
      onDone(`Sent to the engineer: ${r.qty} × ${r.name}, ${rupees(n)}. They confirm it and carry on.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Attach bill and send to engineer" icon={<IconChip icon={Receipt} tone="cyan" />} onClose={onClose}>
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
        <span className="label">Bought from</span>
        <input className="input mt-1" value={vendor} onChange={e => setVendor(e.target.value)} maxLength={120} placeholder="Shop or supplier" />
      </label>

      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={send} disabled={purchase.isPending}>
          {purchase.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Send to engineer
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

function DeclineDialog({ request: r, onClose, onDone }: {
  request: PartRequest
  onClose: () => void
  onDone: (message: string) => void
}) {
  const decline = useDeclinePart()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    setError(null)
    if (reason.trim().length < 3) { setError('Say why it is not being bought.'); return }
    try {
      await decline.mutateAsync({ id: r.id, reason: reason.trim() })
      onDone(`Declined. The engineer sees why and can ask another way.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog title="Decline request" icon={<IconChip icon={ShoppingCart} tone="rose" />} onClose={onClose}>
      <p className="text-sm text-ink-600">{r.qty} × {r.name} · {PART_ROUTE_LABEL[r.route]}</p>
      <label className="block">
        <span className="label">Why <span className="text-cyrixRed-600">*</span></span>
        <textarea className="input mt-1" rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
          placeholder="e.g. Not available locally — use the IRFP450 in stock" />
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
