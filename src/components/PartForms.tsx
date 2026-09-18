import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Boxes, CheckCircle2, ClipboardList, Search, ShoppingCart, Store } from 'lucide-react'
import { useComponents, useRequestPart, useUseComponent, type Component, type Ticket } from '@/lib/queries'
import { PART_ROUTE_LABEL, type PartRoute } from '@/lib/tickets'
import { Spinner } from '@/components/ui'
import PhotoPick, { type PickedPhoto } from '@/components/PhotoPick'

/** Local purchase and Purchase, each in its own colour, chosen or not. */
const ROUTE_LOOK: Record<PartRoute, { on: string; off: string; icon: string; Icon: typeof Store }> = {
  local: { on: 'border-orange-300 bg-orange-50 ring-1 ring-orange-300', off: 'border-ink-200 hover:border-orange-300 hover:bg-orange-50/50', icon: 'text-orange-600', Icon: Store },
  purchase: { on: 'border-violet-300 bg-violet-50 ring-1 ring-violet-300', off: 'border-ink-200 hover:border-violet-300 hover:bg-violet-50/50', icon: 'text-violet-600', Icon: ClipboardList },
}

/** Parts whose number, value, item or package holds every word typed, best matches first. */
export function searchStock(stock: readonly Component[], query: string, limit = 30): Component[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const hay = (c: Component) => [c.part_no, c.value, c.item, c.package].filter(Boolean).join(' ').toLowerCase()
  return stock
    .filter(c => words.every(w => hay(c).includes(w)))
    .sort((a, b) => {
      const exact = (c: Component) => (c.part_no.toLowerCase() === words.join(' ') || (c.value ?? '').toLowerCase() === words.join(' ') ? 0 : 1)
      return exact(a) - exact(b) || (b.qty > 0 ? 1 : 0) - (a.qty > 0 ? 1 : 0) || a.part_no.localeCompare(b.part_no)
    })
    .slice(0, limit)
}

function StockLine({ c, onPick, picked }: { c: Component; onPick?: () => void; picked?: boolean }) {
  const none = c.qty === 0
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={none || !onPick}
      className={clsx(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
        picked ? 'border-indigo-300 bg-indigo-50' : 'border-ink-200 enabled:hover:border-ink-400',
        none && 'opacity-60',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-900">
          {c.value ?? c.item ?? c.part_no} <span className="font-mono text-xs font-normal text-ink-500">{c.part_no}</span>
        </span>
        <span className="block text-xs text-ink-500">{[c.item, c.package].filter(Boolean).join(' · ') || '—'}</span>
      </span>
      <span className={clsx('badge whitespace-nowrap tabular-nums', none ? 'bg-rose-100 text-rose-900' : 'bg-green-100 text-green-900')}>
        {none ? 'None in stock' : `${c.qty} in stock`}
      </span>
    </button>
  )
}

/**
 * Taking a component from the Revive Lab's stock: search by part number,
 * value or type, see how many there are, and say how many were used.
 */
export function UseComponentForm({ ticket: t, onDone, onError, onCancel }: {
  ticket: Ticket
  onDone: (message: string) => void
  onError: (message: string) => void
  onCancel: () => void
}) {
  const { data: stock, isLoading } = useComponents(t.trc_id)
  const use = useUseComponent()
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Component | null>(null)
  const [qty, setQty] = useState('1')

  const found = useMemo(() => searchStock(stock ?? [], q), [stock, q])

  const run = async () => {
    if (!picked) { onError('Choose the component.'); return }
    const n = Number(qty)
    if (!Number.isInteger(n) || n < 1) { onError('Enter how many were used.'); return }
    if (n > picked.qty) { onError(`Only ${picked.qty} in stock.`); return }
    try {
      await use.mutateAsync({ ticketId: t.id, componentId: picked.id, qty: n })
      onDone(`${n} × ${picked.value ?? picked.part_no} (${picked.part_no}) asked for. The coordinator approves it and it comes off the count.`)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-100 text-indigo-700"><Boxes className="h-4 w-4" /></span>
        Use a component from stock
      </p>

      {stock && stock.length === 0 ? (
        <p className="text-sm text-ink-500">
          {t.trc_name} has no stock uploaded yet. Request the component instead, or ask the coordinator to upload the stock sheet.
        </p>
      ) : (
        <>
          <label className="block">
            <span className="label">Search stock at {t.trc_name}</span>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                className="input pl-9"
                value={q}
                onChange={e => { setQ(e.target.value); setPicked(null) }}
                placeholder="Part no, value or type — C-001, IRF 640, MOSFET"
                autoComplete="off"
              />
            </div>
          </label>

          {isLoading && <Spinner className="h-4 w-4 text-ink-400" />}
          {picked ? (
            <StockLine c={picked} picked />
          ) : q.trim() && (
            found.length === 0
              ? <p className="text-sm text-ink-500">Nothing in stock matches. Request it instead.</p>
              : (
                <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                  {found.map(c => <StockLine key={c.id} c={c} onPick={() => { setPicked(c); setQty('1') }} />)}
                </div>
              )
          )}

          {picked && (
            <div className="flex flex-wrap items-end gap-3">
              <label className="block w-32">
                <span className="label">How many</span>
                <input className="input mt-1 tabular-nums" type="number" inputMode="numeric" min={1} max={picked.qty}
                  value={qty} onChange={e => setQty(e.target.value)} />
              </label>
              <button type="button" className="btn-secondary !py-2 text-sm" onClick={() => setPicked(null)}>Choose another</button>
            </div>
          )}
        </>
      )}

      <p className="text-xs text-ink-500">
        The coordinator at {t.trc_name} approves what comes off the stock, and the repair waits until they do.
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={use.isPending || !picked}>
          {use.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Take it from stock
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * Asking for a component that is not in stock: what it is, how many, a
 * photo of it (required, rl_0019) and a link if there is one, and who buys
 * it — the coordinator as a local purchase, or Purchase.
 */
export function RequestPartForm({ ticket: t, onDone, onError, onCancel }: {
  ticket: Ticket
  onDone: (message: string, warning?: string) => void
  onError: (message: string) => void
  onCancel: () => void
}) {
  const { data: stock } = useComponents(t.trc_id)
  const request = useRequestPart()
  const [name, setName] = useState('')
  const [qty, setQty] = useState('1')
  const [route, setRoute] = useState<PartRoute | ''>('')
  const [photos, setPhotos] = useState<PickedPhoto[]>([])
  const [link, setLink] = useState('')
  const [note, setNote] = useState('')

  // Worth a look before buying: what the stock already has under that name.
  const inStock = useMemo(() => (name.trim().length >= 3 ? searchStock(stock ?? [], name, 3).filter(c => c.qty > 0) : []), [stock, name])

  const run = async () => {
    if (name.trim().length < 2) { onError('Enter the component name.'); return }
    const n = Number(qty)
    if (!Number.isInteger(n) || n < 1) { onError('Enter how many are needed.'); return }
    if (!route) { onError('Choose local purchase or purchase.'); return }
    if (link.trim() && !/^https?:\/\//i.test(link.trim())) { onError('The link should start with http:// or https://'); return }
    // Whoever buys it needs to see it (rl_0019).
    if (photos.length === 0) { onError('Add a photo of the component.'); return }
    try {
      const res = await request.mutateAsync({
        ticketId: t.id, route, name: name.trim(), qty: n,
        note: note.trim(), link: link.trim(), photo: photos[0]?.blob ?? null,
      })
      onDone(
        route === 'local'
          ? 'Asked for. The coordinator buys it and writes it into stock.'
          : 'Asked for. The coordinator passes it to Purchase, or buys it locally if they can.',
        res.photoFailed ? 'The request was sent, but its photo did not upload.' : undefined,
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That did not go through.')
    }
  }

  return (
    <div className="card space-y-3 p-4">
      <p className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-orange-100 text-orange-700"><ShoppingCart className="h-4 w-4" /></span>
        Request a component
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
        <label className="block">
          <span className="label">Component <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1" value={name} onChange={e => setName(e.target.value)} maxLength={160}
            placeholder="e.g. LM358 op-amp, 470µF 400V capacitor" />
        </label>
        <label className="block">
          <span className="label">Quantity <span className="text-cyrixRed-600">*</span></span>
          <input className="input mt-1 tabular-nums" type="number" inputMode="numeric" min={1} value={qty} onChange={e => setQty(e.target.value)} />
        </label>
      </div>

      {inStock.length > 0 && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-2.5">
          <p className="text-xs font-medium text-green-800">Already in stock at {t.trc_name} — use it from stock instead?</p>
          <div className="mt-1.5 space-y-1.5">{inStock.map(c => <StockLine key={c.id} c={c} />)}</div>
        </div>
      )}

      <div>
        <span className="label">Bought by <span className="text-cyrixRed-600">*</span></span>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {(['local', 'purchase'] as const).map(r => (
            <button
              key={r}
              type="button"
              onClick={() => setRoute(r)}
              aria-pressed={route === r}
              className={clsx(
                'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                route === r ? ROUTE_LOOK[r].on : ROUTE_LOOK[r].off,
              )}
            >
              {(() => { const Icon = ROUTE_LOOK[r].Icon; return <Icon className={clsx('h-4 w-4 shrink-0', ROUTE_LOOK[r].icon)} /> })()}
              <span>
                <span className="block text-sm font-medium text-ink-900">{PART_ROUTE_LABEL[r]}</span>
                <span className="block text-xs text-ink-500">
                  {r === 'local'
                    ? `The coordinator at ${t.trc_name} buys it`
                    : 'The coordinator passes it to the Purchase team'}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="label">Photo <span className="text-cyrixRed-600">*</span></span>
        <div className="mt-1"><PhotoPick photos={photos} onChange={setPhotos} max={1} noun="photo" /></div>
        <p className="mt-1 text-xs text-ink-500">The part itself, or its marking on the board — whoever buys it goes by this.</p>
      </div>

      <label className="block">
        <span className="label">Link</span>
        <input className="input mt-1" type="url" inputMode="url" value={link} onChange={e => setLink(e.target.value)}
          placeholder="https://… a picture or listing of the part" />
      </label>

      <label className="block">
        <span className="label">Note</span>
        <textarea className="input mt-1" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000}
          placeholder="e.g. Same rating or higher; the board's C12" />
      </label>

      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={run} disabled={request.isPending}>
          {request.isPending ? <Spinner className="h-4 w-4" /> : <ShoppingCart className="h-4 w-4" />} Request component
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
