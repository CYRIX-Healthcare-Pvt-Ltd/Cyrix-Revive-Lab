import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Download, FileSpreadsheet, Plus, Upload, X } from 'lucide-react'
import { readWarehouseGrid, templateBook, type SheetUnit } from '@/lib/warehouseSheet'
import { Spinner } from '@/components/ui'

export interface SheetRow extends SheetUnit { key: number; error?: string }

let nextKey = 1
const toRow = (u: SheetUnit): SheetRow => ({ key: nextKey++, ...u })

/**
 * A warehouse's Excel sheet on the route card (the user, 30 Oct: "when uploading, it should show this much
 * tickets and details, can edit the fields then raise all"). Each row is one ticket, edited in place; the
 * rest of the card — warehouse, Revive Lab, return address, courier — is the same for all of them.
 */
export default function WarehouseSheet({ rows, onChange, disabled }: {
  rows: SheetRow[]
  onChange: (rows: SheetRow[]) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const read = async (file: File) => {
    setProblem(null)
    setReading(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer())
      const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' })
      const { units, error } = readWarehouseGrid(grid)
      if (error) { setProblem(error); return }
      onChange(units.map(toRow))
    } catch {
      setProblem('That file could not be read — save it as .xlsx and try again.')
    } finally {
      setReading(false)
      if (input.current) input.current.value = ''
    }
  }

  const template = async () => {
    const XLSX = await import('xlsx')
    XLSX.writeFile(templateBook(XLSX), 'Warehouse tickets template.xlsx')
  }

  const edit = (key: number, field: keyof SheetUnit, value: string) =>
    onChange(rows.map(r => (r.key === key ? { ...r, [field]: value, error: undefined } : r)))
  const pick = () => input.current?.click()

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label">
          Tickets <span className="text-cyrixRed-600">*</span>
          {rows.length > 0 && <span className="badge ml-1.5 bg-sky-100 text-sky-900">{rows.length}</span>}
        </span>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void template()} className="link-accent inline-flex items-center gap-1 text-xs font-medium">
            <Download className="h-3.5 w-3.5" /> Download template
          </button>
          {rows.length > 0 && (
            <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={pick} disabled={disabled || reading}>
              {reading ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />} Upload again
            </button>
          )}
        </div>
      </div>
      <input ref={input} type="file" accept=".xlsx,.xls,.csv" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void read(f) }} />
      {problem && <p className="text-xs font-medium text-cyrixRed-700">{problem}</p>}

      {rows.length === 0 ? (
        <button
          type="button"
          onClick={pick}
          disabled={disabled || reading}
          className="flex w-full flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-ink-200 px-4 py-6 text-sm font-medium text-ink-700 transition-colors hover:border-ink-400"
        >
          {reading ? <Spinner className="h-6 w-6" /> : <FileSpreadsheet className="h-6 w-6 text-emerald-600" />}
          Upload Excel
        </button>
      ) : (
        <>
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li key={r.key} className={clsx('rounded-lg border p-2.5', r.error ? 'border-cyrixRed-300 bg-cyrixRed-50/50' : 'border-ink-200')}>
                {/* The card's fields, by its names and in its order (the user, 30 Oct: "give the same field names"). */}
                <div className="flex items-end gap-2">
                  <span className="w-6 shrink-0 pb-2 font-mono text-xs text-ink-500">{i + 1}</span>
                  <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
                    <Cell label="Document number" value={r.doc} onChange={v => edit(r.key, 'doc', v)} mono maxLength={60} />
                    <Cell label="Item code" value={r.item} onChange={v => edit(r.key, 'item', v)} mono maxLength={60} />
                    <Cell label="Barcode" value={r.barcode} onChange={v => edit(r.key, 'barcode', v)} mono maxLength={80} className="col-span-2 sm:col-span-1" />
                  </div>
                  <button type="button" className="btn-icon mb-0.5" aria-label={`Remove ticket ${i + 1}`} disabled={disabled}
                    onClick={() => onChange(rows.filter(x => x.key !== r.key))}>
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 pl-8">
                  <Cell label="Spares and accessories" value={r.desc} onChange={v => edit(r.key, 'desc', v)} maxLength={200} />
                </div>
                <div className="mt-2 pl-8">
                  <Cell label="Issue identified" value={r.issue} onChange={v => edit(r.key, 'issue', v)} maxLength={2000} />
                </div>
                {r.error && <p className="mt-1.5 pl-8 text-xs font-medium text-cyrixRed-700">{r.error}</p>}
              </li>
            ))}
          </ol>
          <button type="button" disabled={disabled} className="link-accent inline-flex items-center gap-1 text-sm font-medium"
            onClick={() => onChange([...rows, toRow({ doc: rows[rows.length - 1]?.doc ?? '', item: '', desc: '', barcode: '', issue: '' })])}>
            <Plus className="h-4 w-4" /> Add a ticket
          </button>
        </>
      )}
    </div>
  )
}

function Cell({ label, value, onChange, mono, maxLength, className }: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  maxLength?: number
  className?: string
}) {
  return (
    <label className={clsx('block min-w-0', className)}>
      <span className="text-[11px] font-medium text-ink-500">{label}</span>
      <input className={clsx('input mt-0.5 !py-1.5 text-sm', mono && 'font-mono')} value={value} maxLength={maxLength}
        onChange={e => onChange(e.target.value)} />
    </label>
  )
}
