import { useEffect, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { ITEM_KIND_LABEL, MAX_ITEMS, type ItemKind, type TicketItem } from '@/lib/tickets'

/** A line being typed: the item, and a key that survives a line above it being removed. */
export interface ItemLine extends TicketItem {
  key: number
}

let nextKey = 1
export const newLine = (kind: ItemKind): ItemLine => ({ key: nextKey++, kind, name: '' })

/**
 * The spares and accessories on a route card.
 *
 * The card had one line, Spare name. What comes in from a machine is often
 * more than the board that failed — its cable, its probe — so each line says
 * which it is; and sometimes it is the whole machine (rl_0019). The first
 * starts as a spare; a line added starts as an accessory, which is what
 * usually travels with one; any can be switched. A line left blank is simply
 * not sent.
 */
export default function ItemsField({
  lines, onChange, required, machine,
}: {
  lines: ItemLine[]
  onChange: (next: ItemLine[]) => void
  required?: boolean
  /** The equipment name on the card: what a Full Machine line is, unless told otherwise. */
  machine?: string
}) {
  // The line just added gets the cursor, so adding one is add-and-type.
  const inputs = useRef(new Map<number, HTMLInputElement>())
  const focusNext = useRef<number | null>(null)
  useEffect(() => {
    if (focusNext.current === null) return
    inputs.current.get(focusNext.current)?.focus()
    focusNext.current = null
  }, [lines])

  const change = (key: number, patch: Partial<TicketItem>) =>
    onChange(lines.map(l => (l.key === key ? { ...l, ...patch } : l)))
  // Switched to Full Machine with nothing typed: it is the equipment itself.
  const changeKind = (l: ItemLine, kind: ItemKind) =>
    change(l.key, kind === 'full_machine' && !l.name.trim() && machine?.trim() ? { kind, name: machine.trim() } : { kind })
  const placeholder = (kind: ItemKind) =>
    kind === 'spare' ? 'e.g. SMPS board' : kind === 'accessory' ? 'e.g. Power cable' : machine?.trim() || 'e.g. ECG machine'
  const add = () => {
    const line = newLine('accessory')
    focusNext.current = line.key
    onChange([...lines, line])
  }
  const remove = (key: number) => onChange(lines.filter(l => l.key !== key))

  return (
    <div>
      <span className="label">
        Spares and accessories{required && <> <span className="text-cyrixRed-600">*</span></>}
      </span>
      <ul className="mt-1 space-y-2">
        {lines.map((l, i) => (
          <li key={l.key} className="flex gap-2">
            <select
              className="input w-[8.75rem] shrink-0"
              value={l.kind}
              onChange={e => changeKind(l, e.target.value as ItemKind)}
              aria-label={`Line ${i + 1}: spare, accessory or full machine`}
            >
              <option value="spare">{ITEM_KIND_LABEL.spare}</option>
              <option value="accessory">{ITEM_KIND_LABEL.accessory}</option>
              <option value="full_machine">{ITEM_KIND_LABEL.full_machine}</option>
            </select>
            <input
              ref={el => { if (el) inputs.current.set(l.key, el); else inputs.current.delete(l.key) }}
              className="input min-w-0 flex-1"
              value={l.name}
              onChange={e => change(l.key, { name: e.target.value })}
              placeholder={placeholder(l.kind)}
              maxLength={120}
              aria-label={`Line ${i + 1}: ${ITEM_KIND_LABEL[l.kind].toLowerCase()} name`}
            />
            {lines.length > 1 && (
              <button
                type="button"
                onClick={() => remove(l.key)}
                className="btn-press grid w-10 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                aria-label={`Remove ${l.name.trim() || `line ${i + 1}`}`}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {lines.length < MAX_ITEMS && (
        <button type="button" onClick={add} className="link-accent mt-2 inline-flex items-center gap-1.5 text-sm font-medium">
          <Plus className="h-4 w-4" /> Add spare or accessory
        </button>
      )}
    </div>
  )
}
