import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Boxes, CheckCircle2, ChevronDown, FileSpreadsheet, History, MapPin, Pencil, Plus, ShoppingCart, Undo2, Upload, Wrench, X } from 'lucide-react'
import Dialog from '@/components/Dialog'
import IconChip from '@/components/IconChip'
import { Alert, Spinner } from '@/components/ui'
import { useAddComponent, useEditComponent, usePartHistory, type Component, type PartFields, type PartHistoryLine } from '@/lib/queries'
import { dateTime } from '@/lib/when'
import { partNamed, partNoSuggestions } from '@/lib/stockSheet'

/**
 * Where a part is kept — its BIN and Location (rl_0031) — so whoever goes
 * to get it goes straight there: the engineer choosing it, and the
 * coordinator approving it (the user, 29 Sep).
 */
export function WhereTag({ bin, location, missing = false, className }: {
  bin: string | null | undefined
  location: string | null | undefined
  /** Say so when neither is known, rather than show nothing. */
  missing?: boolean
  className?: string
}) {
  if (!bin && !location) {
    return missing ? <span className={clsx('text-xs text-ink-400', className)}>No BIN or Location yet</span> : null
  }
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-900', className)}>
      <MapPin aria-hidden className="h-3 w-3" />
      {bin && <>BIN {bin}</>}
      {bin && location && <span aria-hidden className="text-sky-700">·</span>}
      {location && <>Location {location}</>}
    </span>
  )
}

/**
 * One part added to the stock, or one changed — the fields of the stock
 * sheet (the user, 29 Sep). A new part's number is suggested, the next
 * after the highest, with the free ones in between offered as well — the
 * series has gaps — and can be changed. A number another part already has
 * is refused before anything is sent, and again by the database.
 */
export function StockPartDialog({ labId, labName, stock, part, onClose, onDone }: {
  labId: string
  labName: string
  stock: readonly Component[]
  /** The part to change; none to add one. */
  part?: Component | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const add = useAddComponent()
  const edit = useEditComponent()
  const suggestions = useMemo(() => partNoSuggestions(stock), [stock])
  const [f, setF] = useState<Record<keyof PartFields, string>>({
    part_no: part?.part_no ?? suggestions[0] ?? '',
    value: part?.value ?? '',
    item: part?.item ?? '',
    package: part?.package ?? '',
    bin: part?.bin ?? '',
    location: part?.location ?? '',
    qty: part ? String(part.qty) : '',
  })
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof PartFields) => (e: React.ChangeEvent<HTMLInputElement>) => setF(x => ({ ...x, [k]: e.target.value }))

  const clash = partNamed(stock, f.part_no, part)
  const busy = add.isPending || edit.isPending

  const save = async () => {
    setError(null)
    const partNo = f.part_no.trim()
    if (!partNo) { setError('Enter the part number.'); return }
    if (clash) { setError(`${clash.part_no} already exists — it is ${[clash.value, clash.item].filter(Boolean).join(' · ') || 'another part'}.`); return }
    if (!f.value.trim() && !f.item.trim()) { setError('Enter the value or the item.'); return }
    const qty = Number(f.qty)
    if (f.qty.trim() === '' || !Number.isInteger(qty) || qty < 0) { setError('Enter the quantity — a whole number, 0 or more.'); return }
    const fields: PartFields = {
      part_no: partNo, value: f.value.trim(), item: f.item.trim(), package: f.package.trim(),
      bin: f.bin.trim(), location: f.location.trim(), qty,
    }
    try {
      if (part) {
        await edit.mutateAsync({ id: part.id, part: fields })
        onDone(`${partNo} saved.`)
      } else {
        await add.mutateAsync({ trcId: labId, part: fields })
        onDone(`${partNo} added to the stock at ${labName}.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <Dialog
      title={part ? `Edit ${part.part_no}` : 'Add stock'}
      icon={<IconChip icon={part ? Pencil : Boxes} tone="indigo" />}
      onClose={onClose}
      wide
    >
      <p className="text-sm text-ink-600">{part ? 'Change any of it — a new quantity is recorded as a stock count.' : `One part, at ${labName}.`}</p>
      {/* Inputs level with each other when a label runs to two lines. */}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Cyrix Part No <span className="text-cyrixRed-600">*</span></span>
          <input
            className={clsx('input mt-1 font-mono', clash && '!border-cyrixRed-500')}
            value={f.part_no}
            onChange={set('part_no')}
            list="stock-part-numbers"
            maxLength={40}
            autoComplete="off"
            aria-invalid={!!clash}
          />
          <datalist id="stock-part-numbers">
            {suggestions.map((s, i) => <option key={s} value={s}>{i === 0 ? 'Next number' : 'Free, in between'}</option>)}
          </datalist>
          {clash ? (
            <span className="mt-1 block text-xs font-medium text-cyrixRed-700" role="alert">
              Already in stock: {[clash.value, clash.item].filter(Boolean).join(' · ') || clash.part_no}
            </span>
          ) : !part && (
            <span className="mt-1 block text-xs text-ink-500">
              Next is {suggestions[0]}{suggestions.length > 1 && <> — free in between: {suggestions.slice(1, 6).join(', ')}{suggestions.length > 6 ? '…' : ''}</>}
            </span>
          )}
        </label>
        <label className="block">
          <span className="label">Value</span>
          <input className="input mt-1" value={f.value} onChange={set('value')} maxLength={160} placeholder="IRF 640, 3.6V 60mAH" />
        </label>
        <label className="block">
          <span className="label">Item</span>
          <input className="input mt-1" value={f.item} onChange={set('item')} maxLength={80} placeholder="MOSFET, IC, GLASS FUSE" />
        </label>
        <label className="block">
          <span className="label">Type</span>
          <input className="input mt-1" value={f.package} onChange={set('package')} maxLength={40} placeholder="TH, SMD, EXT" />
        </label>
        <label className="block">
          <span className="label">BIN</span>
          <input className="input mt-1" value={f.bin} onChange={set('bin')} maxLength={40} placeholder="B1" />
        </label>
        <label className="block">
          <span className="label">Location</span>
          <input className="input mt-1" value={f.location} onChange={set('location')} maxLength={40} placeholder="A2" />
        </label>
        <label className="block">
          <span className="label">Qty <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 tabular-nums" type="number" inputMode="numeric" min={0} step={1} value={f.qty} onChange={set('qty')} />
        </label>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy || !!clash}>
          {busy ? <Spinner className="h-4 w-4" /> : part ? <Pencil className="h-4 w-4" /> : <Boxes className="h-4 w-4" />}
          {part ? 'Save' : 'Add to stock'}
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

const FIELD: Record<string, string> = {
  part_no: 'Part no', value: 'Value', item: 'Item', package: 'Type', bin: 'BIN', location: 'Location', qty: 'Qty',
}
const FIELD_ORDER = ['part_no', 'value', 'item', 'package', 'bin', 'location', 'qty']

/** "BIN B1 → B2 · Qty 4 → 6"; for a new part, just what it was given: "Qty 3 · BIN B9". */
function changeWords(changes: PartHistoryLine['changes'], fresh: boolean): string {
  if (!changes) return ''
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))
  return FIELD_ORDER.filter(k => k in changes && (!fresh || k !== 'part_no'))
    .map(k => (fresh ? `${FIELD[k]} ${show(changes[k][1])}` : `${FIELD[k]} ${show(changes[k][0])} → ${show(changes[k][1])}`))
    .join(' · ')
}

const LOOK: Record<PartHistoryLine['kind'], { icon: typeof Plus; tone: string; title: (l: PartHistoryLine) => string }> = {
  added: { icon: Plus, tone: 'bg-indigo-100 text-indigo-800', title: () => 'Added' },
  sheet_added: { icon: FileSpreadsheet, tone: 'bg-green-100 text-green-800', title: () => 'Added by a stock sheet' },
  edited: { icon: Pencil, tone: 'bg-amber-100 text-amber-800', title: () => 'Edited' },
  sheet_replaced: { icon: FileSpreadsheet, tone: 'bg-green-100 text-green-800', title: () => 'Updated by a stock sheet' },
  counted: { icon: FileSpreadsheet, tone: 'bg-green-100 text-green-800', title: l => `Stock sheet: count set to ${l.qty_after ?? '—'}` },
  requested: { icon: Wrench, tone: 'bg-orange-100 text-orange-800', title: l => `${l.qty} asked for, for ${l.ticket_code}` },
  approved: { icon: CheckCircle2, tone: 'bg-green-100 text-green-800', title: l => `${l.qty} off the stock for ${l.ticket_code}${l.qty_after !== null ? ` · ${l.qty_after} left` : ''}` },
  declined: { icon: X, tone: 'bg-rose-100 text-rose-800', title: l => `Not approved for ${l.ticket_code}` },
  cancelled: { icon: Undo2, tone: 'bg-slate-100 text-slate-800', title: l => `Taken back by the engineer, for ${l.ticket_code}` },
  purchased: { icon: ShoppingCart, tone: 'bg-violet-100 text-violet-800', title: l => `${l.qty ?? ''} purchased for ${l.ticket_code} and put in`.trim() },
}

/**
 * Everything that happened to one part, newest first — who added it, who
 * changed what and from what, each stock sheet that counted it, and each
 * time it was taken for a repair — every person by name and E-code, "if
 * any doubt we can see who updated it" (the user, 29 Sep).
 */
export function PartHistoryDialog({ part: p, onClose }: { part: Component; onClose: () => void }) {
  const { data: lines, isLoading, error } = usePartHistory(p.id)
  return (
    <Dialog title={`${p.part_no} — history`} icon={<IconChip icon={History} tone="indigo" />} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-ink-900">{p.value ?? p.item ?? p.part_no}</span>
        {[p.item, p.package].filter(Boolean).length > 0 && <span className="text-ink-500">{[p.item, p.package].filter(Boolean).join(' · ')}</span>}
        <WhereTag bin={p.bin} location={p.location} />
        <span className={clsx('badge tabular-nums', p.qty === 0 ? 'bg-rose-100 text-rose-900' : 'bg-green-100 text-green-900')}>{p.qty} in stock</span>
      </div>
      {isLoading ? (
        <Spinner className="h-5 w-5 text-ink-400" />
      ) : error ? (
        <Alert kind="error">{error instanceof Error ? error.message : 'The history could not be read.'}</Alert>
      ) : (lines ?? []).length === 0 ? (
        <p className="text-sm text-ink-500">Nothing on record for it yet.</p>
      ) : (
        <ol className="max-h-[60vh] space-y-0 overflow-y-auto pr-1">
          {lines!.map((l, i) => {
            const look = LOOK[l.kind] ?? LOOK.edited
            const detail = l.kind === 'added' || l.kind === 'sheet_added' || l.kind === 'edited' || l.kind === 'sheet_replaced'
              ? changeWords(l.changes, l.kind === 'added' || l.kind === 'sheet_added')
              : l.kind === 'counted' && l.qty !== null
                ? (l.qty === l.qty_after ? 'The first count' : `${l.qty >= 0 ? '+' : ''}${l.qty} on the count before`)
                : ''
            return (
              <li key={`${l.at}-${l.kind}-${i}`} className="flex gap-3 border-b border-ink-100 py-2.5 last:border-b-0">
                <span className={clsx('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full', look.tone)}>
                  <look.icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink-900">
                    {l.ticket_code ? (
                      <>
                        {look.title(l).split(l.ticket_code)[0]}
                        <Link to={`/tickets/${l.ticket_code}`} className="link-accent font-mono" onClick={onClose}>{l.ticket_code}</Link>
                        {look.title(l).split(l.ticket_code)[1]}
                      </>
                    ) : look.title(l)}
                  </p>
                  {detail && <p className="mt-0.5 text-xs text-ink-600">{detail}</p>}
                  {l.note && <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink-600">{l.note}</p>}
                  <p className="mt-0.5 text-xs text-ink-400">
                    {l.who ? <>{l.who}{l.who_ecode && <span className="font-mono"> · {l.who_ecode}</span>}</> : 'Someone no longer here'} · {dateTime(l.at)}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Dialog>
  )
}

/**
 * Upload stock sheet, as a choice (the user, 29 Sep): the template to fill
 * in — the sheet's own seven columns — or a filled sheet to upload.
 */
export function UploadMenu({ busy, onTemplate, onUpload }: { busy: boolean; onTemplate: () => void; onUpload: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const pick = (fn: () => void) => () => { setOpen(false); fn() }
  return (
    <div ref={box} className="relative">
      <button type="button" className="btn-primary !py-1.5 text-sm" onClick={() => setOpen(o => !o)} disabled={busy}
        aria-haspopup="menu" aria-expanded={open}>
        {busy ? <Spinner className="h-4 w-4" /> : <Upload className="h-4 w-4" />} Upload stock sheet
        <ChevronDown aria-hidden className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1.5 w-72 overflow-hidden rounded-xl border border-ink-200 bg-surface p-1 shadow-lg">
          <button type="button" role="menuitem" onClick={pick(onTemplate)}
            className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-ink-50">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <span>
              <span className="block text-sm font-medium text-ink-900">Download template</span>
              <span className="block text-xs text-ink-500">Cyrix- Part No, Value, Item, Type, BIN, Location, Qty — empty, to fill in</span>
            </span>
          </button>
          <button type="button" role="menuitem" onClick={pick(onUpload)}
            className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-ink-50">
            <Upload className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
            <span>
              <span className="block text-sm font-medium text-ink-900">Upload file</span>
              <span className="block text-xs text-ink-500">A filled sheet: you see what it changes before anything is saved</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
